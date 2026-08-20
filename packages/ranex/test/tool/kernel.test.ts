// Kernel bridge tool tests (PM-5, issue #91). Every test runs against the
// committed fake-kernel fixture under test/fixtures/kernel — a POSIX shell
// stand-in for the kernel CLI — plus verdict files signed in-test with a real
// Ed25519 keypair from node:crypto (contract C-6: no uv, no Python, no
// network, no real kernel, no new dependencies). The valid-read state is
// reachable only through real signature verification over the fixture repo's
// actually-derived subject digest.

import { generateKeyPairSync, sign, createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "os"
import path from "path"
import { $ } from "bun"
import { expect } from "bun:test"
import { PermissionV1 } from "@ranex/core/v1/permission"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Config } from "@/config/config"
import { Agent } from "../../src/agent/agent"
import * as Truncate from "../../src/tool/truncate"
import {
  KernelRunTool,
  KernelVerdictTool,
  SIGNED_FIELDS,
  VERDICT_DOMAIN,
  VERDICT_PAYLOAD_TYPE,
  canonicalJson,
  deriveSubjectDigest,
} from "../../src/tool/kernel"
import type { Tool } from "../../src/tool/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import { testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const kernelLayer = Layer.mergeAll(
  LayerNode.compile(LayerNode.group([Truncate.node, Config.node, Agent.node])),
  testInstanceStoreLayer,
)
const it = testEffect(kernelLayer)

const FIXTURE = path.join(import.meta.dir, "../fixtures/kernel")
const SIGNER_ID = "fixture-verdict-signer"
const OTHER_SUBJECT = "sha256:" + "c".repeat(64)
const ZERO_SIGNATURE = "ed25519:" + Buffer.alloc(64).toString("base64")

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

function makeCtx(abort?: AbortSignal) {
  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    abort: abort ?? baseCtx.abort,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

// Builds a fresh kernel repo in a temp dir from the committed fixture: fixture
// files copied, git initialized with one commit (so HEAD^{tree} resolves), and
// the fixture's bin/uv placed first on PATH for the test's lifetime so the
// D3 `uv run ...` form resolves to the fixture.
async function makeKernelRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ranex-kernel-fixture-"))
  await cp(FIXTURE, dir, { recursive: true })
  await chmod(path.join(dir, "bin/uv"), 0o755)
  await $`git init`.cwd(dir).quiet()
  await $`git config user.email test@opencode.test`.cwd(dir).quiet()
  await $`git config user.name Test`.cwd(dir).quiet()
  await $`git add -A`.cwd(dir).quiet()
  await $`git commit -m "fixture kernel"`.cwd(dir).quiet()
  return dir
}

const kernelRepo = Effect.gen(function* () {
  const dir = yield* Effect.promise(() => makeKernelRepo())
  const previousPath = process.env.PATH
  const previousMode = process.env.FIXTURE_KERNEL_MODE
  yield* Effect.sync(() => {
    process.env.PATH = `${dir}/bin${path.delimiter}${previousPath ?? ""}`
    delete process.env.FIXTURE_KERNEL_MODE
  })
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      process.env.PATH = previousPath
      if (previousMode === undefined) delete process.env.FIXTURE_KERNEL_MODE
      else process.env.FIXTURE_KERNEL_MODE = previousMode
      await rm(dir, { recursive: true, force: true })
    }),
  )
  return dir
})

const setEnv = (name: string, value: string | undefined) =>
  Effect.gen(function* () {
    const previous = process.env[name]
    yield* Effect.sync(() => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }),
    )
  })

const writeConfig = (dir: string, kernelPath: string) =>
  Effect.promise(() => writeFile(path.join(dir, "ranex.json"), JSON.stringify({ kernel: { path: kernelPath } })))

// Trusted-layer kernel.path injection: RANEX_CONFIG_CONTENT is read at
// config-load time (unlike the RANEX_CONFIG flag, an import-time snapshot)
// and merged as user-initiated, so it survives the project-config sanitize
// pass (R1). Project-level ranex.json no longer carries kernel.path.
const setTrustedKernelConfig = (kernelPath: string) =>
  setEnv("RANEX_CONFIG_CONTENT", JSON.stringify({ kernel: { path: kernelPath } }))

const fileExists = (file: string) => Effect.promise(() => Bun.file(file).exists())

function initRun() {
  return Effect.gen(function* () {
    const info = yield* KernelRunTool
    return yield* info.init()
  })
}

function initVerdict() {
  return Effect.gen(function* () {
    const info = yield* KernelVerdictTool
    return yield* info.init()
  })
}

function failure<E>(self: Effect.Effect<unknown, E>) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(self)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error("expected the tool to refuse, but it returned a result")
  })
}

function sha256Hex(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function generateSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer
  return { privateKey, public: "ed25519:" + spki.subarray(spki.length - 32).toString("base64") }
}

// Writes a byte-valid signed verdict envelope in the kernel's exact wire shape
// (payload_type/record/signatures; record = the signed fields plus
// record_digest; signature = base64 Ed25519 over `ranex-verdict-v1\n` + the
// canonical JSON of the signed fields), and registers the signer in the
// fixture repo's keyring. `fileSubject` defaults to `subject`: for the
// subject-mismatch case the file is filed under one digest while being signed
// about another.
async function writeSignedVerdict(input: {
  kernelDir: string
  signer: ReturnType<typeof generateSigner>
  subject: string
  fileSubject?: string
  overrides?: Record<string, unknown>
  signerId?: string
  payloadType?: string
  tamper?: (envelope: string) => string
}) {
  const content: Record<string, unknown> = {
    verdict: "PASS",
    gate_id: "landing",
    subject_digest: input.subject,
    subject_lane: "PRE_READINESS_PRODUCT_SLICE",
    catalog_digest: "sha256:" + "b".repeat(64),
    approver_id: "owner",
    failing_rule: null,
    missing_claims: [],
    considered: [],
    causes: [],
    rejections: [],
    self_approval: false,
    reason: "fixture verdict",
    ...input.overrides,
  }
  const signature = sign(null, Buffer.from(VERDICT_DOMAIN + canonicalJson(content), "utf8"), input.signer.privateKey)
  const envelope = canonicalJson({
    payload_type: input.payloadType ?? VERDICT_PAYLOAD_TYPE,
    record: { ...content, record_digest: "sha256:" + sha256Hex(canonicalJson(content)) },
    signatures: [{ signer_id: input.signerId ?? SIGNER_ID, signature: "ed25519:" + signature.toString("base64") }],
  })
  const dir = path.join(input.kernelDir, "governance/verdicts")
  await mkdir(dir, { recursive: true })
  const fileSubject = input.fileSubject ?? input.subject
  await writeFile(path.join(dir, `${fileSubject.slice("sha256:".length)}.json`), input.tamper?.(envelope) ?? envelope)
}

async function writeKeyring(kernelDir: string, signer?: ReturnType<typeof generateSigner>, publicKeyOverride?: string) {
  const publicKey = publicKeyOverride ?? signer?.public ?? "ed25519:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
  await writeFile(
    path.join(kernelDir, "governance/producers.yaml"),
    [
      "producers:",
      "  fixture-producer: ed25519:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
      "verdict_signer:",
      `  id: ${SIGNER_ID}`,
      `  public_key: ${publicKey}`,
      "",
    ].join("\n"),
  )
}

const clearVerdicts = (kernelDir: string) =>
  Effect.promise(() => rm(path.join(kernelDir, "governance/verdicts"), { recursive: true, force: true }))

// Scans Linux /proc for processes whose cmdline carries `token` (the unique
// sleep durations the liveness tests plant inside the kernel's process group).
// Returns [] where /proc does not exist (non-Linux dev hosts; CI is Linux).
function scanProc(token: string): string[] {
  try {
    return readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)).filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(token)
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

// The token must disappear within the window: group SIGTERM removes plain
// descendants immediately, and the 3 s SIGKILL escalation removes TERM-immune
// ones — a survivor that never dies means the group kill (or its escalation)
// never fired.
async function waitForGroupDeath(token: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (scanProc(token).length === 0) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return scanProc(token).length === 0
}

// --- G-1 happy paths -------------------------------------------------------

it.instance(
  "records evidence through the fixture kernel",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setTrustedKernelConfig(kernelDir)
      yield* setEnv("RANEX_KERNEL", undefined)

      const run = yield* initRun()
      const { requests, ctx } = makeCtx()
      const result = yield* run.execute(
        { claim: "fixture-tests-executed", producer: "fixture-producer", command: ["true"] },
        ctx,
      )

      const expectedSubject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
      expect(requests[0]?.permission).toBe("kernel_run")
      expect(result.metadata.recorded).toBe(true)
      expect(result.metadata.exitCode).toBe(0)
      expect(result.metadata.subjectDigest).toBe(expectedSubject)
      expect(result.metadata.evidencePath).toBe(path.join(kernelDir, "governance/evidence.json"))
      expect(result.output).toContain("kernel_run: recorded")
      expect(result.output).toContain(expectedSubject)
      // The kernel's real command output is surfaced, not summarized.
      expect(result.output).toContain("RECORDED  claim=fixture-tests-executed  producer=fixture-producer  exit=0")
      // The kernel recorded its evidence file.
      const evidence = yield* Effect.promise(() => Bun.file(path.join(kernelDir, "governance/evidence.json")).text())
      expect(evidence).toContain('"claim_id": "fixture-tests-executed"')
      expect(evidence).toContain(`"subject_digest": "${expectedSubject}"`)
    }),
  { git: true },
)

it.instance(
  "records evidence of a failing measured command honestly",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)

      const run = yield* initRun()
      const { ctx } = makeCtx()
      const result = yield* run.execute(
        { claim: "fixture-failing-claim", producer: "fixture-producer", command: ["false"] },
        ctx,
      )

      // A failing command is recorded evidence of failure (kernel semantics), not a tool error.
      expect(result.metadata.recorded).toBe(true)
      expect(result.metadata.exitCode).toBe(1)
      expect(result.output).toContain("exit=1")
    }),
  { git: true },
)

it.instance(
  "records evidence passthrough of kernel-side digest refusal",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)
      yield* setEnv("FIXTURE_KERNEL_MODE", "command-digest-mismatch")

      const run = yield* initRun()
      const { ctx } = makeCtx()
      const result = yield* run.execute(
        { claim: "fixture-tests-executed", producer: "fixture-producer", command: ["true"] },
        ctx,
      )

      // Kernel-side refusal passes through as an evidence failure with stderr surfaced — never silently accepted.
      expect(result.metadata.recorded).toBe(false)
      expect(result.metadata.exitCode).toBe(2)
      expect(result.output).toContain("did NOT record evidence (kernel-refused)")
      expect(result.output).toContain("command digest does not match")
    }),
  { git: true },
)

it.instance(
  "records evidence via RANEX_KERNEL env fallback",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      const instance = yield* TestInstance
      // No kernel config written: discovery must fall back to the env var.
      yield* setEnv("RANEX_KERNEL", kernelDir)

      const run = yield* initRun()
      const { ctx } = makeCtx()
      const result = yield* run.execute(
        { claim: "fixture-tests-executed", producer: "fixture-producer", command: ["true"] },
        ctx,
      )
      expect(result.metadata.recorded).toBe(true)
    }),
  { git: true },
)

it.instance(
  "records evidence with config kernel.path taking precedence over env",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      // Trusted config layer (RANEX_CONFIG_CONTENT) vs env: config wins.
      yield* setTrustedKernelConfig(kernelDir)
      yield* setEnv("RANEX_KERNEL", "/nonexistent-kernel-path")

      const run = yield* initRun()
      const { ctx } = makeCtx()
      const result = yield* run.execute(
        { claim: "fixture-tests-executed", producer: "fixture-producer", command: ["true"] },
        ctx,
      )
      expect(result.metadata.recorded).toBe(true)
    }),
  { git: true },
)

it.instance(
  "records evidence ignoring project-level kernel.path (kernel is stripped from untrusted config)",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      const instance = yield* TestInstance
      // Direct proof of the strip through the sanitize path itself (R1):
      // `kernel` is permission-adjacent, so it joins provider credentials and
      // experimental.policies on the stripped list, without touching
      // unrelated keys.
      const sanitized = Config.sanitizeProjectConfig({ model: "anthropic/claude", kernel: { path: "/project/kernel" } })
      expect(sanitized.info.kernel).toBeUndefined()
      expect(sanitized.info.model).toBe("anthropic/claude")
      expect(sanitized.stripped).toEqual(["kernel"])

      // End to end: a project-level ranex.json naming its own kernel is
      // ignored, and discovery still resolves via the trusted env layer.
      yield* writeConfig(instance.directory, "/nonexistent-project-kernel")
      yield* setEnv("RANEX_KERNEL", kernelDir)

      const run = yield* initRun()
      const { ctx } = makeCtx()
      const result = yield* run.execute(
        { claim: "fixture-tests-executed", producer: "fixture-producer", command: ["true"] },
        ctx,
      )
      expect(result.metadata.recorded).toBe(true)
    }),
  { git: true },
)

it.instance(
  "records evidence anchored on the kernel's last summary line, not poisoned early matches",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)

      const run = yield* initRun()
      const { ctx } = makeCtx()
      // The measured command emits kernel-shaped poison lines BEFORE the
      // kernel prints its real summary after the command exits; anchoring on
      // the FIRST match would record the poison fields.
      const fake = "sha256:" + "a".repeat(64)
      const result = yield* run.execute(
        {
          claim: "fixture-tests-executed",
          producer: "fixture-producer",
          command: [
            "sh",
            "-c",
            `echo 'RECORDED  claim=poison  producer=poison  exit=99'; echo '          subject=${fake}'`,
          ],
        },
        ctx,
      )

      const expectedSubject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
      expect(result.metadata.recorded).toBe(true)
      expect(result.metadata.subjectDigest).toBe(expectedSubject)
      expect(result.metadata.subjectDigest).not.toBe(fake)
      expect(result.output).toContain("exit: 0")
    }),
  { git: true },
)

it.instance(
  "records evidence from output that floods past the capture cap",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)

      const run = yield* initRun()
      const { ctx } = makeCtx()
      // 60 KiB of measured-command output overruns the 50 KiB capture cap.
      // The retained window is the TAIL — shell.ts's discipline — so the
      // kernel's RECORDED summary (printed after the flood) still parses and
      // the result is marked truncated, never unbounded memory.
      const result = yield* run.execute(
        { claim: "fixture-tests-executed", producer: "fixture-producer", command: ["sh", "-c", "yes xxxx | head -c 61440"] },
        ctx,
      )

      const expectedSubject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
      expect(result.metadata.recorded).toBe(true)
      expect(result.metadata.subjectDigest).toBe(expectedSubject)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("earliest output was dropped")
    }),
  { git: true },
)

it.instance(
  "records evidence via RANEX_KERNEL when trusted config kernel.path is blank",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      // A blank (empty or whitespace) kernel.path counts as unset instead of
      // blocking, so an operator can blank the trusted config and let the
      // env var take over. Only empty config AND empty env refuses (SP-1).
      yield* setTrustedKernelConfig("   ")
      yield* setEnv("RANEX_KERNEL", kernelDir)

      const run = yield* initRun()
      const { ctx } = makeCtx()
      const result = yield* run.execute(
        { claim: "fixture-tests-executed", producer: "fixture-producer", command: ["true"] },
        ctx,
      )
      expect(result.metadata.recorded).toBe(true)
    }),
  { git: true },
)

it.instance(
  "reads verdict with valid signature and renders freshness-unproven",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setTrustedKernelConfig(kernelDir)
      yield* setEnv("RANEX_KERNEL", undefined)
      // Signed over the fixture repo's actually-derived subject digest, via
      // the same tool-side derivation the reader uses — so the valid-read
      // state is reachable only through real verification.
      const signer = generateSigner()
      const subject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
      yield* Effect.promise(() => writeKeyring(kernelDir, signer).then(() => writeSignedVerdict({ kernelDir, signer, subject })))

      const verdict = yield* initVerdict()
      const { requests, ctx } = makeCtx()
      const result = yield* verdict.execute({}, ctx)

      expect(requests[0]?.permission).toBe("kernel_verdict")
      expect(result.metadata.state).toBe("freshness-unproven")
      expect(result.metadata.subjectDigest).toBe(subject)
      expect(result.output).toContain("kernel verdict: freshness-unproven (signature verified)")
      expect(result.output).toContain("verdict: \"PASS\"")
      expect(result.output).toContain("gate_id: \"landing\"")
      expect(result.output).toContain("not that it is current")
      // R3: the freshness-unproven header surfaces the verdict's gate context
      // up front so "signature verified" cannot be mistaken for "this gate's
      // verdict" — with the limit stated in plain words.
      expect(result.output).toContain("gate: landing")
      expect(result.output).toContain(`catalog: sha256:${"b".repeat(64)}`)
      expect(result.output).toContain("approver: owner")
      expect(result.output).toContain("this session has NOT confirmed")
    }),
  { git: true },
)

// --- G-3 sad paths (every name carries "refuses") --------------------------

it.instance(
  "refuses when kernel.path is unset",
  () =>
    Effect.gen(function* () {
      // No kernel config written and no env var set: absence must block.
      yield* setEnv("RANEX_KERNEL", undefined)

      const run = yield* initRun()
      const { ctx } = makeCtx()
      const message = yield* failure(
        run.execute({ claim: "fixture-tests-executed", producer: "fixture-producer", command: ["true"] }, ctx),
      )
      expect(message).toContain("KERNEL_PATH_UNSET")
      expect(message).toContain("RANEX_KERNEL")

      const verdict = yield* initVerdict()
      const verdictMessage = yield* failure(verdict.execute({}, ctx))
      expect(verdictMessage).toContain("KERNEL_PATH_UNSET")
    }),
  { git: true },
)

it.instance(
  "refuses relative kernel.path",
  () =>
    Effect.gen(function* () {
      yield* setTrustedKernelConfig("some/relative/kernel")
      yield* setEnv("RANEX_KERNEL", undefined)

      const run = yield* initRun()
      const { ctx } = makeCtx()
      const message = yield* failure(
        run.execute({ claim: "fixture-tests-executed", producer: "fixture-producer", command: ["true"] }, ctx),
      )
      expect(message).toContain("KERNEL_PATH_RELATIVE")
    }),
  { git: true },
)

it.instance(
  "refuses nonexistent kernel.path",
  () =>
    Effect.gen(function* () {
      yield* setEnv("RANEX_KERNEL", path.join(os.tmpdir(), "ranex-kernel-does-not-exist"))

      const run = yield* initRun()
      const { ctx } = makeCtx()
      const message = yield* failure(
        run.execute({ claim: "fixture-tests-executed", producer: "fixture-producer", command: ["true"] }, ctx),
      )
      expect(message).toContain("KERNEL_PATH_MISSING")
    }),
  { git: true },
)

it.instance(
  "refuses kernel.path inside the session worktree",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      // A kernel repo placed inside the session worktree — the agent could edit the kernel that judges it.
      const source = yield* Effect.promise(() => makeKernelRepo())
      const kernelDir = path.join(instance.directory, "kernel")
      yield* Effect.promise(() =>
        cp(source, kernelDir, { recursive: true }).then(() => rm(source, { recursive: true, force: true })),
      )
      yield* setEnv("RANEX_KERNEL", kernelDir)

      const run = yield* initRun()
      const { ctx } = makeCtx()
      const message = yield* failure(
        run.execute({ claim: "fixture-tests-executed", producer: "fixture-producer", command: ["true"] }, ctx),
      )
      expect(message).toContain("KERNEL_PATH_INSIDE_WORKTREE")
      expect(message).toContain(kernelDir)
      // No subprocess may have run.
      expect(yield* fileExists(path.join(kernelDir, ".fixture-kernel-invoked"))).toBe(false)
    }),
  { git: true },
)

it.instance(
  "refuses kernel.path inside the harness repo",
  () =>
    Effect.gen(function* () {
      // The committed fixture itself lives inside the harness repo.
      yield* setTrustedKernelConfig(FIXTURE)

      const run = yield* initRun()
      const { ctx } = makeCtx()
      const message = yield* failure(
        run.execute({ claim: "fixture-tests-executed", producer: "fixture-producer", command: ["true"] }, ctx),
      )
      expect(message).toContain("KERNEL_PATH_INSIDE_HARNESS")
      expect(message).toContain(FIXTURE)
    }),
  { git: true },
)

it.instance(
  "refuses claims not declared in the catalog before spawning",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)

      const run = yield* initRun()
      const { ctx } = makeCtx()
      const message = yield* failure(
        run.execute({ claim: "arbitrary-unlisted-claim", producer: "fixture-producer", command: ["true"] }, ctx),
      )
      expect(message).toContain("KERNEL_CLAIM_NOT_IN_CATALOG")
      expect(message).toContain("arbitrary-unlisted-claim")
      // Refused BEFORE spawning: the fixture leaves no invocation marker.
      expect(yield* fileExists(path.join(kernelDir, ".fixture-kernel-invoked"))).toBe(false)
    }),
  { git: true },
)

it.instance(
  "refuses kernel subprocess failure with structured evidence failure",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)
      const run = yield* initRun()
      const { ctx } = makeCtx()

      yield* setEnv("FIXTURE_KERNEL_MODE", "fail")
      const refused = yield* run.execute(
        { claim: "fixture-tests-executed", producer: "fixture-producer", command: ["true"] },
        ctx,
      )
      expect(refused.metadata.recorded).toBe(false)
      expect(refused.metadata.exitCode).toBe(2)
      expect(refused.output).toContain("exit: 2")
      expect(refused.output).toContain("fixture kernel refusal")

      yield* setEnv("FIXTURE_KERNEL_MODE", "malformed")
      const malformed = yield* run.execute(
        { claim: "fixture-tests-executed", producer: "fixture-producer", command: ["true"] },
        ctx,
      )
      expect(malformed.metadata.recorded).toBe(false)
      expect(malformed.metadata.exitCode).toBe(1)
      expect(malformed.output).toContain("evidence-malformed")
      expect(malformed.output).toContain("not-json{{{")
    }),
  { git: true },
)

it.instance(
  "refuses on verdict subject digest mismatch showing both digests",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)
      const signer = generateSigner()
      const subject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
      // Correctly signed, but about a different subject; filed under the
      // worktree's derived digest so the reader finds it and must refuse.
      yield* Effect.promise(() => writeKeyring(kernelDir, signer).then(() => writeSignedVerdict({ kernelDir, signer, subject: OTHER_SUBJECT, fileSubject: subject })))

      const verdict = yield* initVerdict()
      const { ctx } = makeCtx()
      const result = yield* verdict.execute({}, ctx)

      expect(result.metadata.state).toBe("subject-mismatch")
      // BOTH digests, verbatim.
      expect(result.output).toContain(`worktree subject: ${subject}`)
      expect(result.output).toContain(`verdict subject: ${OTHER_SUBJECT}`)
      expect(result.output).not.toContain("verdict: \"PASS\"")
    }),
  { git: true },
)

it.instance(
  "refuses to render an absent verdict as pass",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)
      // No verdict file exists at all.

      const verdict = yield* initVerdict()
      const { ctx } = makeCtx()
      const result = yield* verdict.execute({}, ctx)

      expect(result.metadata.state).toBe("absent")
      expect(result.output).toContain("kernel verdict: absent")
      expect(result.output).toContain("Absence is not a pass")
      expect(result.output).not.toContain("\"PASS\"")
      expect(result.output).not.toContain("freshness-unproven (signature verified)")
    }),
  { git: true },
)

it.instance(
  "refuses tampered verdict bytes as unverified",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)
      const signer = generateSigner()
      const subject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
      yield* Effect.promise(() => writeKeyring(kernelDir, signer))

      // Edited record bytes: the verdict string no longer matches the signed bytes.
      yield* Effect.promise(() =>
        writeSignedVerdict({
          kernelDir,
          signer,
          subject,
          tamper: (envelope) => envelope.replace('"verdict":"PASS"', '"verdict":"FAIL"'),
        }),
      )
      const verdict = yield* initVerdict()
      const { ctx } = makeCtx()
      const tamperedRecord = yield* verdict.execute({}, ctx)
      expect(tamperedRecord.metadata.state).toBe("unverified")
      expect(tamperedRecord.output).toContain("kernel verdict: unverified")

      // Forged signature bytes over unchanged content.
      yield* clearVerdicts(kernelDir)
      yield* Effect.promise(() =>
        writeSignedVerdict({
          kernelDir,
          signer,
          subject,
          tamper: (envelope) => envelope.replace(/"signature":"ed25519:[A-Za-z0-9+/=]+"/, `"signature":"${ZERO_SIGNATURE}"`),
        }),
      )
      const forged = yield* verdict.execute({}, ctx)
      expect(forged.metadata.state).toBe("unverified")
    }),
  { git: true },
)

it.instance(
  "refuses malformed verdict envelopes as unverified",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)
      const signer = generateSigner()
      const subject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
      yield* Effect.promise(() => writeKeyring(kernelDir, signer))

      // Not JSON at all.
      const dir = path.join(kernelDir, "governance/verdicts")
      yield* Effect.promise(() => mkdir(dir, { recursive: true }))
      yield* Effect.promise(() => writeFile(path.join(dir, `${subject.slice("sha256:".length)}.json`), "not-json{{{"))
      const verdict = yield* initVerdict()
      const { ctx } = makeCtx()
      const unparseable = yield* verdict.execute({}, ctx)
      expect(unparseable.metadata.state).toBe("unverified")

      // Unsigned: an empty signatures list.
      yield* clearVerdicts(kernelDir)
      yield* Effect.promise(() =>
        writeSignedVerdict({
          kernelDir,
          signer,
          subject,
          tamper: (envelope) => envelope.replace(/"signatures":\[[^\]]*\]/, '"signatures":[]'),
        }),
      )
      const unsigned = yield* verdict.execute({}, ctx)
      expect(unsigned.metadata.state).toBe("unverified")

      // Extra envelope key.
      yield* clearVerdicts(kernelDir)
      yield* Effect.promise(() =>
        writeSignedVerdict({
          kernelDir,
          signer,
          subject,
          tamper: (envelope) => envelope.replace(/^\{/, '{"extra":1,'),
        }),
      )
      const extraKey = yield* verdict.execute({}, ctx)
      expect(extraKey.metadata.state).toBe("unverified")

      // Record missing one of the signed fields.
      yield* clearVerdicts(kernelDir)
      yield* Effect.promise(() =>
        writeSignedVerdict({
          kernelDir,
          signer,
          subject,
          tamper: (envelope) => envelope.replace('"reason":"fixture verdict",', ""),
        }),
      )
      const missingField = yield* verdict.execute({}, ctx)
      expect(missingField.metadata.state).toBe("unverified")
      expect(missingField.output).toContain("kernel verdict: unverified")
    }),
  { git: true },
)

it.instance(
  "refuses unknown verdict producers",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)
      const signer = generateSigner()
      const subject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
      yield* Effect.promise(() =>
        writeKeyring(kernelDir, signer).then(() => writeSignedVerdict({ kernelDir, signer, subject, signerId: "someone-else" })),
      )

      const verdict = yield* initVerdict()
      const { ctx } = makeCtx()
      const result = yield* verdict.execute({}, ctx)

      expect(result.metadata.state).toBe("unknown-producer")
      expect(result.output).toContain("kernel verdict: unknown-producer")
      expect(result.output).toContain("someone-else")
    }),
  { git: true },
)

it.instance(
  "refuses wrong verdict payload types",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)
      const signer = generateSigner()
      const subject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
      yield* Effect.promise(() =>
        writeKeyring(kernelDir, signer).then(() =>
          writeSignedVerdict({ kernelDir, signer, subject, payloadType: "application/vnd.ranex.other.v1+json" }),
        ),
      )

      const verdict = yield* initVerdict()
      const { ctx } = makeCtx()
      const result = yield* verdict.execute({}, ctx)

      expect(result.metadata.state).toBe("wrong-type")
      expect(result.output).toContain("kernel verdict: wrong-type")
    }),
  { git: true },
)

it.instance(
  "refuses unclassified verdict causes by blocking",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)
      const signer = generateSigner()
      const subject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
      yield* Effect.promise(() =>
        writeKeyring(kernelDir, signer).then(() =>
          // Correctly signed and about this subject, but carrying a cause the
          // reader cannot classify: it must block, never render a verdict.
          writeSignedVerdict({ kernelDir, signer, subject, overrides: { causes: [{ claim_id: "x", cause: "mystery" }] } }),
        ),
      )

      const verdict = yield* initVerdict()
      const { ctx } = makeCtx()
      const result = yield* verdict.execute({}, ctx)

      expect(result.metadata.state).toBe("unclassified")
      expect(result.output).toContain("kernel verdict: unclassified — BLOCKED")
      expect(result.output).not.toContain("verdict: \"PASS\"")
    }),
  { git: true },
)

it.instance(
  "refuses to hang: typed KERNEL_TIMEOUT with the kernel process group killed",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)
      yield* setEnv("RANEX_KERNEL_TIMEOUT_MS", "400")

      const run = yield* initRun()
      const { ctx } = makeCtx()
      // The measured command leaves a descendant (backgrounded sleep, unique
      // duration doubles as the /proc scan token) that only a GROUP kill
      // reaches — a direct-child kill would orphan it.
      const message = yield* failure(
        run.execute(
          { claim: "fixture-tests-executed", producer: "fixture-producer", command: ["sh", "-c", "sleep 811.5 & wait"] },
          ctx,
        ),
      )
      expect(message).toContain("KERNEL_TIMEOUT")
      expect(message).toContain("RANEX_KERNEL_TIMEOUT_MS")
      expect(yield* Effect.promise(() => waitForGroupDeath("811.5", 2000))).toBe(true)

      // A TERM-immune group member survives the group SIGTERM; only the 3 s
      // SIGKILL escalation removes it, and the refusal still never hangs.
      const stubborn = yield* failure(
        run.execute(
          {
            claim: "fixture-tests-executed",
            producer: "fixture-producer",
            command: ["sh", "-c", "trap '' TERM; while :; do sleep 811.6; done"],
          },
          ctx,
        ),
      )
      expect(stubborn).toContain("KERNEL_TIMEOUT")
      expect(yield* Effect.promise(() => waitForGroupDeath("811.6", 8000))).toBe(true)

      // A descendant holding the output pipe after the kernel itself exited:
      // settlement must not wait for the pipe (the drain grace releases it) —
      // the run stays a recorded success, marked truncated, never a hang.
      const held = yield* run.execute(
        { claim: "fixture-tests-executed", producer: "fixture-producer", command: ["sh", "-c", "sleep 8 & exec true"] },
        ctx,
      )
      expect(held.metadata.recorded).toBe(true)
      expect(held.metadata.truncated).toBe(true)
      expect(held.output).toContain("truncated")
    }),
  { git: true },
  // Two drain-grace windows plus the SIGKILL-escalation poll legitimately
  // exceed the 5 s default.
  30000,
)

it.instance(
  "refuses with missing-key when the keyring's key string is malformed",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)
      const signer = generateSigner()
      const subject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
      // The verdict itself is validly signed, but the committed keyring
      // publishes a garbage key string for the right signer id: the key is
      // unavailable (missing-key), not a signature attack (bad-signature).
      yield* Effect.promise(() =>
        writeKeyring(kernelDir, signer, "not-an-ed25519-key").then(() => writeSignedVerdict({ kernelDir, signer, subject })),
      )

      const verdict = yield* initVerdict()
      const { ctx } = makeCtx()
      const result = yield* verdict.execute({}, ctx)

      expect(result.metadata.state).toBe("unverified")
      expect(result.output).toContain("kernel verdict: unverified (missing-key)")
    }),
  { git: true },
)

it.instance(
  "refuses with a typed SUBJECT_DERIVE_FAILED when the digest cannot be derived",
  () =>
    Effect.gen(function* () {
      // A directory that passes discovery (absolute, exists, outside the
      // worktree and harness) but is not a git repo: HEAD^{tree} cannot
      // resolve, and the refusal carries a stable code, not a bare error.
      const dir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "ranex-kernel-nogit-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(dir, { recursive: true, force: true })))
      yield* setEnv("RANEX_KERNEL", dir)

      const verdict = yield* initVerdict()
      const { ctx } = makeCtx()
      const message = yield* failure(verdict.execute({}, ctx))
      expect(message).toContain("SUBJECT_DERIVE_FAILED")
    }),
  { git: true },
)

it.instance(
  "labels aborted kernel runs instead of presenting them as clean evidence",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* setEnv("RANEX_KERNEL", kernelDir)

      const run = yield* initRun()
      const controller = new AbortController()
      const { ctx } = makeCtx(controller.signal)
      // Abort mid-run: the group kill takes the same path as the timeout and
      // the result is marked aborted — never presented as a clean record.
      const fiber = yield* run
        .execute(
          { claim: "fixture-tests-executed", producer: "fixture-producer", command: ["sh", "-c", "sleep 811.4 & wait"] },
          ctx,
        )
        .pipe(Effect.forkScoped)
      yield* Effect.sleep("300 millis")
      yield* Effect.sync(() => controller.abort())
      const result = yield* Fiber.join(fiber)

      expect(result.metadata.aborted).toBe(true)
      expect(result.metadata.recorded).toBe(false)
      expect(result.output).toContain("session aborted")
      expect(yield* Effect.promise(() => waitForGroupDeath("811.4", 2000))).toBe(true)
    }),
  { git: true },
)

// The wire shape the fixture signs matches the kernel's signed-field contract
// exactly — a guard against drifting fixtures.
it.live("signs exactly the kernel's signed fields", () =>
  Effect.sync(() => {
    expect(SIGNED_FIELDS).toEqual([
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
    ])
  }),
)
