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
// Kernel discovery (contract C-1): explicit config `kernel.path`, else the
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

async function exec(cmd: string[], cwd: string, env: Record<string, string | undefined>, abort?: AbortSignal) {
  const proc = Bun.spawn({ cmd, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
    async ([stdout, stderr]) => ({ exitCode: await proc.exited, stdout, stderr }),
  )
  if (!abort) return done
  // A session abort must not leave the kernel subprocess running unowned.
  if (abort.aborted) {
    proc.kill()
    return done
  }
  const kill = () => proc.kill()
  abort.addEventListener("abort", kill, { once: true })
  try {
    return await done
  } finally {
    abort.removeEventListener("abort", kill)
  }
}

// The subject digest the kernel pins (OBSERVED src/ranex/cli/main.py:171-177
// `subject_digest_for`): `git rev-parse "HEAD^{tree}"` in the kernel repo, then
// `sha256:` + SHA-256 hex over the canonical JSON of the single-key object
// `{"tree": <hex>}`. Exported so tests derive expected digests through the same
// tool-side path the reader uses (contract AC-3).
export async function deriveSubjectDigest(kernelDir: string) {
  const result = await exec(["git", "rev-parse", "HEAD^{tree}"], kernelDir, process.env)
  if (result.exitCode !== 0) throw new Error(`cannot resolve HEAD^{tree} in kernel repo: ${result.stderr.trim()}`)
  return "sha256:" + sha256Hex(canonicalJson({ tree: result.stdout.trim() }))
}

// The kernel repo root is four levels above this module (repo/packages/ranex/
// src/tool). In an installed layout this resolves to the harness installation
// root instead — refusing a kernel inside it is still the right check.
const harnessRoot = path.resolve(import.meta.dir, "../../../..")

const resolveKernel = Effect.fn("KernelTool.resolveKernel")(function* (kernelPath: string | undefined, envPath: string | undefined, ins: InstanceContext) {
  const configured = kernelPath ?? envPath
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
  const signatureBytes = decodeEd25519(signature.signature, 64)
  const publicKeyBytes = decodeEd25519(signer.publicKey, 32)
  if (signatureBytes === undefined || publicKeyBytes === undefined) return { state: "unverified", reason: "bad-signature" }
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

          const exit = result.stdout.match(/^RECORDED.*\bexit=(-?\d+)/m)?.[1]
          const subject = result.stdout.match(/^\s*subject=(sha256:[0-9a-f]{64})/m)?.[1]
          const header = kernelRunHeader(params.claim, result, exit, subject)
          const output = [
            ...header,
            `evidence: ${evidencePath}`,
            "",
            result.stdout.trim() || "(no kernel stdout)",
            ...(result.stderr.trim() ? ["", "--- kernel stderr ---", result.stderr.trim()] : []),
          ].join("\n")
          return {
            title: `kernel_run ${params.claim}`,
            metadata: {
              recorded: exit !== undefined && subject !== undefined,
              exitCode: result.exitCode,
              ...(subject ? { subjectDigest: subject } : {}),
              evidencePath,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

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
