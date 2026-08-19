// Kernel bridge tools (PM-5, issue #91).
//
// The ranex-kernel is a separate repository that records governed evidence and
// publishes signed verdicts (kernel docs/adr/ADR-019-the-verdict-read-channel.md).
// The bridge is SUBPROCESS-ONLY: the harness never imports kernel code and never
// judges anything itself. `kernel_run` wraps the kernel CLI's `run` subcommand
// so a session can cite kernel-recorded evidence; `kernel_verdict` is a
// READ-ONLY reader of the kernel's ADR-019 signed verdict files. Verdict
// production stays a human act — no code path here invokes `gate evaluate` or
// parses its output (contract C-5), and the harness writes nothing to the
// kernel repository.
//
// Kernel discovery (contract C-1): explicit config `kernel.path` from trusted
// layers only (global config, RANEX_CONFIG/RANEX_CONFIG_CONTENT — project
// configs are sanitized, see config.ts sanitizeProjectConfig), else the
// RANEX_KERNEL env var. The resolved path must be absolute, must exist, and
// must resolve OUTSIDE both the current session worktree and the harness repo —
// a kernel the observed session can edit would judge its own editor. Absence
// blocks: an unset or invalid kernel location is a refusal, never a skip.

import path from "path"
import { createHash, createPublicKey, verify } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { parse } from "yaml"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@ranex/core/fs-util"
import type { InstanceContext } from "../project/instance-context"
import * as Tool from "./tool"

const VERDICT_DIR = "governance/verdicts"
const GATE_CATALOG = "governance/gates.yaml"
const PRODUCERS = "governance/producers.yaml"
const EVIDENCE = "governance/evidence.json"

// Wire format of the kernel's signed verdict publication, mirroring the
// kernel's foundation/verdict_signing.py byte for byte: the domain separator is
// `ranex-verdict-v1\n`, signatures are base64 Ed25519 over the domain bytes
// plus the canonical JSON of exactly the signed fields, and keys/signatures
// carry the `ed25519:<base64>` prefix with canonical base64 spelling.
export const VERDICT_PAYLOAD_TYPE = "application/vnd.ranex.verdict.v1+json"
export const VERDICT_DOMAIN = "ranex-verdict-v1\n"
export const SIGNED_FIELDS = [
  "verdict",
  "gate_id",
  "subject_digest",
  "subject_lane",
  "catalog_digest",
  "approver_id",
  "failing_rule",
  "missing_claims",
  "considered",
  "causes",
  "rejections",
  "self_approval",
  "reason",
] as const
const KNOWN_CAUSES = ["contradicted", "failed", "mismatched", "stale", "absent", "refused", "unattributable"]

// Presentation states of the ADR-019 read channel. The kernel's reader has ten
// internal states (governed_execution/verdict_reader.py); they collapse into
// this presentation set without losing coverage: malformed/unsigned/
// bad-signature/missing-key → unverified, unknown-signer → unknown-producer,
// wrong-payload-type → wrong-type, context-mismatch → subject-mismatch,
// absent → absent, verified → freshness-unproven (a valid read whose freshness
// is not established), and unknown-cause plus anything unclassifiable →
// unclassified, which BLOCKS. A state the reader cannot classify never renders
// as a pass, and absence is its own state.
type VerdictRead =
  | { state: "absent" }
  | { state: "unverified"; reason: "malformed" | "unsigned" | "bad-signature" | "missing-key" }
  | { state: "unknown-producer"; signer: string }
  | { state: "wrong-type" }
  | { state: "subject-mismatch"; verdictSubject: unknown }
  | { state: "unclassified"; detail: string }
  | { state: "freshness-unproven"; record: Record<string, unknown> }

// Stable refusal error so callers and logs see a code plus the failing check
// name (contract observability requirement). Never carries key material.
class KernelRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`kernel bridge refused [${code}]: ${message}`)
  }
}

// Canonical JSON mirroring the kernel's foundation/canonical.py: recursively
// sorted keys, compact separators, non-ASCII left unescaped. The subject digest
// and the verdict record/signature bytes must hash identically on both sides.
export function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite numbers are not canonicalizable")
    return JSON.stringify(value)
  }
  if (typeof value === "boolean") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const body = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${body.join(",")}}`
  }
  throw new Error(`value of type ${typeof value} is not canonicalizable`)
}

function sha256Hex(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

// Output capture is byte-capped, mirroring the shell tool's truncation
// discipline (truncate.ts MAX_BYTES): a kernel subprocess that floods stdout
// or stderr can never grow harness memory without bound. Like shell.ts, the
// retained window is the TAIL (the kernel prints its RECORDED summary after
// the measured command's output, so the newest bytes carry the evidence).
// The stream keeps being consumed past the cap (retaining nothing) so a full
// pipe can never block or SIGPIPE the subprocess mid-run.
const MAX_OUTPUT_BYTES = 50 * 1024

function readCapped(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let used = 0
  let truncated = false
  const result = (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(Buffer.from(next.value))
      used += next.value.byteLength
      if (used <= MAX_OUTPUT_BYTES) continue
      truncated = true
      // Drop the oldest chunks until the window fits again; a single chunk
      // larger than the whole cap keeps only its tail.
      while (used > MAX_OUTPUT_BYTES && chunks.length > 1) {
        const dropped = chunks.shift()
        if (!dropped) break
        used -= dropped.byteLength
      }
      if (used > MAX_OUTPUT_BYTES && chunks.length === 1) {
        chunks[0] = chunks[0]!.subarray(used - MAX_OUTPUT_BYTES)
        used = MAX_OUTPUT_BYTES
      }
    }
    return { text: Buffer.concat(chunks).toString("utf8"), truncated }
  })()
  const handle = {
    result,
    released: false,
    // Force-close the read side. Whether late bytes would have followed is
    // unknowable afterwards, so a release conservatively marks the capture
    // truncated.
    release: () => {
      handle.released = true
      reader.cancel().catch(() => {})
    },
  }
  return handle
}

// After the direct child exits, its streams normally close at once. A
// descendant that inherited the pipe can hold it open; this grace bounds how
// long exec waits for the drain before releasing the pipes — a stuck
// descendant never hangs the tool and never misreports a finished run as a
// timeout. The release marks the capture truncated (conservative: whether
// late bytes would have arrived is unknowable).
const DRAIN_GRACE_MS = 3000

async function settleOutputs(stdout: ReturnType<typeof readCapped>, stderr: ReturnType<typeof readCapped>) {
  const drained = Promise.all([stdout.result, stderr.result])
  const grace = new Promise((resolve) => setTimeout(resolve, DRAIN_GRACE_MS).unref())
  if (await Promise.race([drained.then(() => true), grace.then(() => false)])) return drained
  stdout.release()
  stderr.release()
  const [out, err] = await drained
  return [
    { ...out, truncated: out.truncated || stdout.released },
    { ...err, truncated: err.truncated || stderr.released },
  ] as const
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000

// RANEX_KERNEL_TIMEOUT_MS overrides the default (which mirrors the shell
// tool's two minutes). A value that is not a finite positive number falls
// back to the default rather than silently disabling the cap.
function kernelTimeoutMs() {
  const raw = process.env.RANEX_KERNEL_TIMEOUT_MS
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS
  // setTimeout coerces its delay to a signed 32-bit int; anything above
  // 2^31-1 would fire after ~1 ms instead of extending the cap.
  return Math.min(parsed, 2 ** 31 - 1)
}

// The kernel subprocess is spawned detached, so it leads its own process
// group and a kill reaches every descendant it spawned (the measured command
// included), not just the direct child. SIGTERM first, escalating to SIGKILL
// after a 3 s grace — the same escalation the shell tool uses. exec settles
// as soon as the direct child is gone, so a stubborn descendant can never
// hang the tool; the escalation timer finishes the group behind it, probing
// first so a dead group's id can never be signalled after recycling.
function killProcessGroup(proc: Bun.Subprocess) {
  if (process.platform === "win32") {
    // No process groups on Windows; taskkill /T /F is the harness's
    // established tree-kill there (core/shell.ts, util/process.ts). If
    // taskkill itself fails or reports a non-zero exit, fall back to
    // killing the direct child — mirroring util/process.ts stop(). The
    // destroyer's exit is consumed so it can never linger as an unowned
    // zombie child itself.
    const killDirect = () => {
      try {
        proc.kill()
      } catch {}
    }
    try {
      const killer = Bun.spawn({ cmd: ["taskkill", "/pid", String(proc.pid), "/T", "/F"], stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      killer.exited.then(
        (code) => {
          if (code !== 0) killDirect()
        },
        () => killDirect(),
      )
    } catch {
      killDirect()
    }
    return
  }
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, name)
    } catch {
      try {
        proc.kill(name)
      } catch {}
    }
  }
  signal("SIGTERM")
  setTimeout(() => {
    try {
      // Signal 0 probes existence: skip the SIGKILL when the group is gone.
      process.kill(-proc.pid, 0)
    } catch {
      return
    }
    signal("SIGKILL")
  }, 3000).unref()
}

// Liveness contract: exec settles as soon as the DIRECT child exits — the
// default 2-minute timeout (RANEX_KERNEL_TIMEOUT_MS) bounds even a kernel
// that never returns, killing its whole process group and refusing with the
// typed KERNEL_TIMEOUT code. Never a hang.
async function exec(cmd: string[], cwd: string, env: Record<string, string | undefined>, abort?: AbortSignal) {
  const proc = Bun.spawn({ cmd, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: process.platform !== "win32" })
  const stdout = readCapped(proc.stdout)
  const stderr = readCapped(proc.stderr)
  // On spawn failure `proc.exited` rejects before settleOutputs attaches any
  // handler; these no-op catches keep the capture promises from surfacing as
  // unhandled rejections (the real error propagates via proc.exited below).
  stdout.result.catch(() => {})
  stderr.result.catch(() => {})
  let timedOut = false
  const timer = setTimeout(() => {
    // The child may have exited inside the timeout with its exit event
    // still queued behind this callback — including a signal death, which
    // leaves exitCode null — so skip the kill then (util/process.ts uses
    // the same two-field guard).
    if (proc.exitCode !== null || proc.signalCode !== null) return
    timedOut = true
    killProcessGroup(proc)
  }, kernelTimeoutMs())
  // A session abort must not leave the kernel subprocess running unowned;
  // it takes the same group-kill path as the timeout, and the result carries
  // an aborted marker so an aborted run is never presented as clean
  // evidence.
  let aborted = false
  const kill = () => {
    aborted = true
    killProcessGroup(proc)
  }
  if (abort?.aborted) kill()
  else abort?.addEventListener("abort", kill, { once: true })
  try {
    const exitCode = await proc.exited
    // The timeout bounds the CHILD. Disarm it the moment the child is gone:
    // a slow pipe drain afterwards (settleOutputs) must never mislabel a
    // finished run as timed out.
    clearTimeout(timer)
    const [out, err] = await settleOutputs(stdout, stderr)
    if (timedOut) {
      throw new KernelRefusedError(
        "KERNEL_TIMEOUT",
        `the kernel subprocess did not exit within ${kernelTimeoutMs()} ms and its process ${
          process.platform === "win32" ? "tree was killed (taskkill /T /F)" : "group was killed (SIGTERM, escalating to SIGKILL after 3 s)"
        }; raise RANEX_KERNEL_TIMEOUT_MS if the kernel legitimately runs longer`,
      )
    }
    return { exitCode, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated, aborted }
  } finally {
    clearTimeout(timer)
    abort?.removeEventListener("abort", kill)
  }
}

// The subject digest the kernel pins (OBSERVED src/ranex/cli/main.py:171-177
// `subject_digest_for`): `git rev-parse "HEAD^{tree}"` in the kernel repo, then
// `sha256:` + SHA-256 hex over the canonical JSON of the single-key object
// `{"tree": <hex>}`. Exported so tests derive expected digests through the same
// tool-side path the reader uses (contract AC-3).
export async function deriveSubjectDigest(kernelDir: string) {
  const result = await exec(["git", "rev-parse", "HEAD^{tree}"], kernelDir, process.env)
  if (result.exitCode !== 0)
    throw new KernelRefusedError(
      "SUBJECT_DERIVE_FAILED",
      `cannot derive the worktree subject digest (git rev-parse HEAD^{tree}) in the kernel repo ${kernelDir}: ${result.stderr.trim()}`,
    )
  return "sha256:" + sha256Hex(canonicalJson({ tree: result.stdout.trim() }))
}

// The kernel repo root is four levels above this module (repo/packages/ranex/
// src/tool). In an installed layout this resolves to the harness installation
// root instead — refusing a kernel inside it is still the right check.
const harnessRoot = path.resolve(import.meta.dir, "../../../..")

// The first value that is present and non-blank: a blank (empty or
// whitespace) kernel.path — and likewise a blank RANEX_KERNEL — counts as
// unset, so an operator can blank the trusted config and let the env var
// take over (or vice versa). Only a genuinely-empty config AND empty env
// refuses as UNSET.
function firstSetPath(...values: Array<string | undefined>) {
  return values.find((value) => value !== undefined && value.trim() !== "")
}

const resolveKernel = Effect.fn("KernelTool.resolveKernel")(function* (kernelPath: string | undefined, envPath: string | undefined, ins: InstanceContext) {
  const configured = firstSetPath(kernelPath, envPath)
  if (!configured) {
    return yield* refuse("KERNEL_PATH_UNSET", "kernel discovery failed: neither config kernel.path nor the RANEX_KERNEL env var is set; absence blocks")
  }
  if (!path.isAbsolute(configured)) {
    return yield* refuse("KERNEL_PATH_RELATIVE", `kernel.path must be absolute, got ${configured}`)
  }
  // Thrown errors inside Effect.promise become defects Effect.catch cannot
  // intercept, so the resolution result is modeled explicitly.
  const resolved = yield* Effect.promise(() =>
    realpath(configured).then(
      (dir) => ({ ok: true as const, dir }),
      () => ({ ok: false as const }),
    ),
  )
  if (!resolved.ok) {
    return yield* refuse("KERNEL_PATH_MISSING", `kernel.path does not exist or cannot be resolved: ${configured}`)
  }
  const dir = resolved.dir
  // Symlinks are resolved before the location check so a link cannot dress an
  // inside path as an outside one. Compare realpaths on both sides.
  const worktree = yield* Effect.promise(() => realpath(ins.worktree).catch(() => ins.worktree))
  const directory = yield* Effect.promise(() => realpath(ins.directory).catch(() => ins.directory))
  if ((worktree !== "/" && FSUtil.contains(worktree, dir)) || FSUtil.contains(directory, dir)) {
    return yield* refuse("KERNEL_PATH_INSIDE_WORKTREE", `kernel.path ${dir} resolves inside the session worktree (${worktree}); the kernel that judges the session must be outside it`)
  }
  const harness = yield* Effect.promise(() => realpath(harnessRoot).catch(() => harnessRoot))
  if (FSUtil.contains(harness, dir)) {
    return yield* refuse("KERNEL_PATH_INSIDE_HARNESS", `kernel.path ${dir} resolves inside the harness repository (${harness}); the kernel that judges the harness must be outside it`)
  }
  return dir
})

function refuse(code: string, message: string) {
  return Effect.logWarning("kernel bridge refused", { code }).pipe(
    Effect.andThen(Effect.die(new KernelRefusedError(code, message))),
  )
}

async function loadCatalogClaims(kernelDir: string) {
  let text: string
  try {
    text = await readFile(path.join(kernelDir, GATE_CATALOG), "utf8")
  } catch {
    throw new KernelRefusedError("KERNEL_CATALOG_ABSENT", `the kernel's committed gate catalog is missing: ${GATE_CATALOG}`)
  }
  let document: unknown
  try {
    document = parse(text)
  } catch (error) {
    throw new KernelRefusedError("KERNEL_CATALOG_MALFORMED", `gate catalog ${GATE_CATALOG} is not valid YAML: ${String(error)}`)
  }
  const gates = (document as { gates?: unknown }).gates
  if (!Array.isArray(gates)) throw new KernelRefusedError("KERNEL_CATALOG_MALFORMED", `gate catalog ${GATE_CATALOG} has no gates list`)
  return gates.flatMap((gate) => {
    const claims = (gate as { required_claims?: unknown }).required_claims
    if (!Array.isArray(claims)) return []
    return claims.flatMap((claim) => {
      const id = (claim as { claim_id?: unknown }).claim_id
      return typeof id === "string" ? [id] : []
    })
  })
}

// The verdict signer keyring: the kernel publishes one trusted verdict signer
// in governance/producers.yaml. An unreadable or malformed keyring yields no
// keys — the reader then reports unverified (missing-key), never a pass.
async function loadVerdictSigner(kernelDir: string) {
  let text: string
  try {
    text = await readFile(path.join(kernelDir, PRODUCERS), "utf8")
  } catch {
    return undefined
  }
  try {
    const signer = (parse(text) as { verdict_signer?: unknown }).verdict_signer
    const id = (signer as { id?: unknown } | undefined)?.id
    const publicKey = (signer as { public_key?: unknown } | undefined)?.public_key
    if (typeof id === "string" && typeof publicKey === "string") return { id, publicKey }
  } catch {
    return undefined
  }
  return undefined
}

const ED25519_PREFIX = "ed25519:"
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

// Mirrors the kernel's foundation/signing.py `_decode`: `ed25519:<base64>`,
// strict alphabet, canonical re-encoding (the same bytes have exactly one
// spelling, and identity is keyed by that string), and an exact byte length.
function decodeEd25519(value: unknown, expected: number) {
  if (typeof value !== "string" || !value.startsWith(ED25519_PREFIX)) return undefined
  const encoded = value.slice(ED25519_PREFIX.length)
  if (!encoded || !BASE64.test(encoded)) return undefined
  const raw = Buffer.from(encoded, "base64")
  if (raw.toString("base64") !== encoded || raw.length !== expected) return undefined
  return raw
}

// Raw 32-byte Ed25519 public keys are wrapped in their DER SPKI envelope so
// node:crypto can verify them; no external dependency needed.
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex")

function verifyEd25519(message: Buffer, signature: Buffer, publicKey: Buffer) {
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, publicKey]), format: "der", type: "spki" })
  return verify(null, message, key, signature)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value)
}

// The reader half of ADR-019, mirroring governed_execution/verdict_reader.py
// state for state. The harness enforces the subject-digest component of the
// kernel's context tuple: gate/catalog/approver identity is operator-side
// context the bridge does not own, so a verified record whose subject matches
// the derived worktree digest reads as valid with freshness explicitly
// unproven. Unclassifiable content blocks.
function classifyVerdict(file: Buffer, signer: { id: string; publicKey: string } | undefined, subject: string): VerdictRead {
  let value: unknown
  try {
    value = JSON.parse(file.toString("utf8"))
  } catch {
    return { state: "unverified", reason: "malformed" }
  }
  if (!isPlainObject(value) || !sameKeys(value, ["payload_type", "record", "signatures"])) {
    return { state: "unverified", reason: "malformed" }
  }
  if (value.payload_type !== VERDICT_PAYLOAD_TYPE) return { state: "wrong-type" }
  const signatures = value.signatures
  if (!Array.isArray(signatures)) return { state: "unverified", reason: "malformed" }
  if (signatures.length === 0) return { state: "unverified", reason: "unsigned" }
  const signature = signatures[0]
  if (!isPlainObject(signature) || !sameKeys(signature, ["signer_id", "signature"])) {
    return { state: "unverified", reason: "malformed" }
  }
  const signerId = signature.signer_id
  if (typeof signerId !== "string") return { state: "unverified", reason: "malformed" }
  if (signer === undefined || signer.id !== signerId) {
    // An empty keyring means the key is unavailable (missing-key); a keyring
    // that does not name this signer means the producer is unknown.
    return signer === undefined
      ? { state: "unverified", reason: "missing-key" }
      : { state: "unknown-producer", signer: signerId }
  }
  const record = value.record
  if (!isPlainObject(record) || !sameKeys(record, [...SIGNED_FIELDS, "record_digest"])) {
    return { state: "unverified", reason: "malformed" }
  }
  const content: Record<string, unknown> = {}
  for (const field of SIGNED_FIELDS) content[field] = record[field]
  if (record.record_digest !== "sha256:" + sha256Hex(canonicalJson(content))) {
    return { state: "unverified", reason: "bad-signature" }
  }
  // A keyring entry whose key string does not decode means the key is
  // unavailable — missing-key, matching the loader's contract above. This is
  // checked before the signature: without a key, verification cannot even be
  // attempted. A malformed SIGNATURE is an attack on the envelope, not a
  // missing key.
  const publicKeyBytes = decodeEd25519(signer.publicKey, 32)
  if (publicKeyBytes === undefined) return { state: "unverified", reason: "missing-key" }
  const signatureBytes = decodeEd25519(signature.signature, 64)
  if (signatureBytes === undefined) return { state: "unverified", reason: "bad-signature" }
  const message = Buffer.from(VERDICT_DOMAIN + canonicalJson(content), "utf8")
  if (!verifyEd25519(message, signatureBytes, publicKeyBytes)) return { state: "unverified", reason: "bad-signature" }
  if (record.subject_digest !== subject) {
    return { state: "subject-mismatch", verdictSubject: record.subject_digest }
  }
  const causes = record.causes
  if (!Array.isArray(causes)) return { state: "unverified", reason: "malformed" }
  if (causes.some((cause) => !isPlainObject(cause) || !KNOWN_CAUSES.includes(String(cause.cause)))) {
    return { state: "unclassified", detail: "the verdict carries a cause the reader cannot classify" }
  }
  return { state: "freshness-unproven", record }
}

function renderRecord(record: Record<string, unknown>) {
  return Object.keys(record)
    .sort()
    .map((key) => `  ${key}: ${JSON.stringify(record[key])}`)
    .join("\n")
}

function renderField(value: unknown) {
  // Strings print bare for readability, but control characters are escaped
  // so a signed record cannot inject lines or terminal escapes into the
  // tool output — these fields are rendered precisely because they are NOT
  // independently verified.
  if (typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value)) return value
  return JSON.stringify(value)
}

// No default arm: the switch is exhaustive over VerdictRead, and absence
// renders as absence — never as a pass.
function renderVerdict(read: VerdictRead, subject: string) {
  switch (read.state) {
    case "absent":
      return [
        "kernel verdict: absent",
        `subject: ${subject}`,
        "No verdict publication exists for this subject. Absence is not a pass; the gate is not satisfied.",
      ].join("\n")
    case "unverified":
      return [
        `kernel verdict: unverified (${read.reason})`,
        `subject: ${subject}`,
        "The verdict publication cannot be verified, so it is refused; no verdict content is rendered.",
      ].join("\n")
    case "unknown-producer":
      return [
        "kernel verdict: unknown-producer",
        `subject: ${subject}`,
        `signer: ${read.signer}`,
        "The verdict names a signer the kernel's committed keyring does not publish; refused.",
      ].join("\n")
    case "wrong-type":
      return [
        "kernel verdict: wrong-type",
        `subject: ${subject}`,
        "The verdict publication's payload type is unsupported; refused.",
      ].join("\n")
    case "subject-mismatch":
      return [
        "kernel verdict: subject-mismatch",
        `worktree subject: ${subject}`,
        `verdict subject: ${read.verdictSubject}`,
        "The verdict belongs to a different subject (both digests shown); refused.",
      ].join("\n")
    case "unclassified":
      return [
        "kernel verdict: unclassified — BLOCKED",
        `subject: ${subject}`,
        `detail: ${read.detail}`,
        "A state the reader cannot classify blocks; nothing is rendered as a verdict.",
      ].join("\n")
    case "freshness-unproven":
      return [
        "kernel verdict: freshness-unproven (signature verified)",
        `subject: ${subject}`,
        `gate: ${renderField(read.record.gate_id)}`,
        `catalog: ${renderField(read.record.catalog_digest)}`,
        `approver: ${renderField(read.record.approver_id)}`,
        "Verified so far: the signature and the subject digest. gate, catalog, and approver above are the verdict's own signed claims about itself — this session has NOT confirmed they match the gate being evaluated.",
        "verdict record:",
        renderRecord(read.record),
        "Note: verification proves the verdict is about this subject's tree, not that it is current.",
      ].join("\n")
  }
}

const KERNEL_RUN_DESCRIPTION = `Run a command through the ranex-kernel so its observation is recorded as governed evidence.

Executes the kernel CLI's \`run\` subcommand as a subprocess with the kernel repository as the working directory. The claim must be declared in the kernel's committed gate catalog (governance/gates.yaml); arbitrary claims are refused. Returns the recorded evidence fields (exit code, subject digest, evidence path) plus the kernel's real command output. A failing measured command is still recorded evidence of failure — do not retry without changing something. This tool records evidence; it never evaluates gates or produces verdicts.`

export const KernelRunTool = Tool.define(
  "kernel_run",
  Effect.gen(function* () {
    const config = yield* Config.Service
    return {
      description: KERNEL_RUN_DESCRIPTION,
      parameters: Schema.Struct({
        claim: Schema.String.annotate({ description: "Claim id from the kernel's governance/gates.yaml that this run evidences" }),
        producer: Schema.String.annotate({ description: "Producer identity the kernel keyring has registered for this session" }),
        command: Schema.mutable(Schema.Array(Schema.String)).annotate({
          description: "The command argv (after the kernel's -- separator) whose observation is recorded",
        }),
      }),
      execute: (params: { claim: string; producer: string; command: string[] }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "kernel_run",
            patterns: [params.claim],
            always: [],
            metadata: { claim: params.claim, producer: params.producer, command: params.command },
          })

          const info = yield* config.get()
          const ins = yield* InstanceState.context
          const kernelDir = yield* resolveKernel(info.kernel?.path, process.env.RANEX_KERNEL, ins)

          const claims = yield* Effect.promise(() => loadCatalogClaims(kernelDir))
          if (!claims.includes(params.claim)) {
            return yield* refuse(
              "KERNEL_CLAIM_NOT_IN_CATALOG",
              `claim ${params.claim} is not declared in the kernel's committed gate catalog (${GATE_CATALOG}); refusing before spawning`,
            )
          }

          const evidencePath = path.join(kernelDir, EVIDENCE)
          // The D3 bridge form, verbatim: the kernel CLI is addressed through
          // `uv run` with PYTHONPATH=src and cwd = the kernel repo. The env is
          // the operator's own (same-uid trust posture, kernel RISK-06 parity:
          // inheriting the signing key is disclosed trust, not a boundary). The
          // MEASURED command's environment is built from empty by the kernel
          // itself (kernel ADR-005 hermetic observation); this env only reaches
          // the kernel process, never the measured command.
          const result = yield* Effect.promise(() =>
            exec(
              [
                "uv",
                "run",
                "--frozen",
                "python",
                "-m",
                "ranex.cli.main",
                "run",
                "--claim",
                params.claim,
                "--producer",
                params.producer,
                "--",
                ...params.command,
              ],
              kernelDir,
              { ...process.env, PYTHONPATH: "src" },
              ctx.abort,
            ),
          )

          // Anchor on the LAST RECORDED/subject match, not the first: the
          // kernel prints its summary after the measured command's output, so
          // a measured command printing kernel-shaped lines cannot poison the
          // parsed evidence fields with earlier matches.
          const exit = lastMatch(result.stdout, /^RECORDED.*\bexit=(-?\d+)/gm)
          const subject = lastMatch(result.stdout, /^\s*subject=(sha256:[0-9a-f]{64})/gm)
          const header = kernelRunHeader(params.claim, result, exit, subject)
          const output = [
            ...header,
            `evidence: ${evidencePath}`,
            "",
            result.stdout.trim() || "(no kernel stdout)",
            ...(result.truncated ? ["", `(kernel output truncated at the ${MAX_OUTPUT_BYTES}-byte capture cap; earliest output was dropped)`] : []),
            ...(result.aborted ? ["", "(session aborted: the kernel process group was killed — any kernel output above predates the abort)"] : []),
            ...(result.stderr.trim() ? ["", "--- kernel stderr ---", result.stderr.trim()] : []),
          ].join("\n")
          return {
            title: `kernel_run ${params.claim}`,
            metadata: {
              recorded: exit !== undefined && subject !== undefined,
              exitCode: result.exitCode,
              ...(subject ? { subjectDigest: subject } : {}),
              evidencePath,
              ...(result.truncated ? { truncated: true } : {}),
              ...(result.aborted ? { aborted: true } : {}),
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

// First capture group of the LAST regex match in `text` (patterns are /g).
function lastMatch(text: string, pattern: RegExp) {
  let last: string | undefined
  for (const match of text.matchAll(pattern)) last = match[1]
  return last
}

// The kernel's refusal contract is an `ERROR  ...` line on stderr and no
// RECORDED line; output unusable in some other way is malformed evidence.
// Both surface as structured failure, never as a pass.
function kernelRunHeader(
  claim: string,
  result: { exitCode: number; stdout: string; stderr: string },
  exit: string | undefined,
  subject: string | undefined,
) {
  if (exit !== undefined && subject !== undefined) {
    return [`kernel_run: recorded`, `claim: ${claim}`, `exit: ${exit}`, `subject: ${subject}`]
  }
  const state = result.stderr.match(/^ERROR  /m) ? "kernel-refused" : "evidence-malformed"
  return [`kernel_run: did NOT record evidence (${state})`, `exit: ${result.exitCode}`]
}

const KERNEL_VERDICT_DESCRIPTION = `Read the ranex-kernel's signed verdict (ADR-019 read channel) for the kernel repo's current worktree HEAD, read-only.

Derives the subject digest exactly as the kernel does, then reads the signed verdict file at governance/verdicts/<subject-digest>.json. The result is one of a total set of reader states: absent, unverified, unknown-producer, wrong-type, subject-mismatch, freshness-unproven (a signature-verified read whose freshness is not established), or unclassified (blocked). Absence is never a pass. This tool never writes, signs, or produces verdicts — verdict production is the operator's act.`

export const KernelVerdictTool = Tool.define(
  "kernel_verdict",
  Effect.gen(function* () {
    const config = yield* Config.Service
    return {
      description: KERNEL_VERDICT_DESCRIPTION,
      parameters: Schema.Struct({}),
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* config.get()
          const ins = yield* InstanceState.context
          const kernelDir = yield* resolveKernel(info.kernel?.path, process.env.RANEX_KERNEL, ins)

          yield* ctx.ask({
            permission: "kernel_verdict",
            patterns: [kernelDir],
            always: [],
            metadata: { kernel: kernelDir },
          })

          const subject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
          const verdictPath = path.join(kernelDir, VERDICT_DIR, `${subject.slice("sha256:".length)}.json`)
          const signer = yield* Effect.promise(() => loadVerdictSigner(kernelDir))
          const read = yield* Effect.promise(async () => {
            try {
              return classifyVerdict(await readFile(verdictPath), signer, subject)
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code
              if (code === "ENOENT") return { state: "absent" } as const
              return { state: "unverified", reason: "malformed" } as const
            }
          })

          return {
            title: `kernel_verdict ${read.state}`,
            metadata: { state: read.state, subjectDigest: subject, ...(signer ? { signerId: signer.id } : {}) },
            output: renderVerdict(read, subject),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as KernelTool from "./kernel"
