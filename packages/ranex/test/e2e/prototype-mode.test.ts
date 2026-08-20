// Prototype mode assembled end-to-end (PM-6, issue #92).
//
// Drives a REAL session in prototype mode through the actual session stack
// (SessionPrompt.loop + ToolRegistry + Agent registry) against the #91 fake
// kernel fixture copied to a temp dir, with the scripted mock LLM server as
// the model (no network beyond loopback, no real kernel, no uv, no Python).
// What is under test is the ASSEMBLY: the prototype agent's prompt reaching
// the model, the kernel bridge tools executing inside the session with the
// prototype permission rows, the ADR-019 verdict states rendering into the
// persisted transcript, and the evidence-gated completion contract holding —
// an absent verdict blocks the done claim and is never rendered as a pass.

import { generateKeyPairSync, sign, createHash } from "node:crypto"
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "os"
import path from "path"
import { $ } from "bun"
import { expect } from "bun:test"
import { ConfigV1 } from "@ranex/core/v1/config/config"
import { SessionV1 } from "@ranex/core/v1/session"
import { SessionProjector } from "@ranex/core/session/projector"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Database } from "@ranex/core/database/database"
import { FSUtil } from "@ranex/core/fs-util"
import { Effect, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "@/image/image"
import { LSP } from "../../src/lsp/lsp"
import { LLM } from "../../src/session/llm"
import { MCP } from "../../src/mcp"
import { MessageV2 } from "../../src/session/message-v2"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Question } from "../../src/question"
import { SessionID } from "../../src/session/schema"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "@/session/system"
import { Instruction } from "@/session/instruction"
import { Todo } from "@/session/todo"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Ripgrep } from "@ranex/core/ripgrep"
import { Format } from "../../src/format"
import { CrossSpawnSpawner } from "@ranex/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import {
  VERDICT_DOMAIN,
  VERDICT_PAYLOAD_TYPE,
  canonicalJson,
  deriveSubjectDigest,
} from "../../src/tool/kernel"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// --- session stack (mirrors test/session/prompt.test.ts makeHttp) ----------

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    onReconnect: () => Effect.succeed(() => {}),
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prototype e2e"),
    authenticate: () => Effect.die("unexpected MCP auth in prototype e2e"),
    finishAuth: () => Effect.die("unexpected MCP auth in prototype e2e"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const runtimeFlags = RuntimeFlags.layer({ experimentalEventSystem: true })

const testLLMServerNode = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const promptRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  AgentSvc.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  ProviderSvc.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

const it = testEffect(
  LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, runtimeFlags],
  ]),
)

// --- kernel fixture + config helpers ---------------------------------------

const FIXTURE = path.join(import.meta.dir, "../fixtures/kernel")
const SIGNER_ID = "fixture-verdict-signer"
const OTHER_SUBJECT = "sha256:" + "c".repeat(64)

// Fresh kernel repo in a temp dir built from the committed #91 fixture,
// consumed as-is (no fixture edits): files copied, git initialized with one
// commit so HEAD^{tree} resolves.
const kernelRepo = Effect.gen(function* () {
  const dir = yield* Effect.promise(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ranex-e2e-kernel-"))
    await cp(FIXTURE, dir, { recursive: true })
    await chmod(path.join(dir, "bin/uv"), 0o755)
    await $`git init`.cwd(dir).quiet()
    await $`git config user.email test@opencode.test`.cwd(dir).quiet()
    await $`git config user.name Test`.cwd(dir).quiet()
    await $`git add -A`.cwd(dir).quiet()
    await $`git commit -m "fixture kernel"`.cwd(dir).quiet()
    return dir
  })
  yield* Effect.addFinalizer(() => Effect.promise(() => rm(dir, { recursive: true, force: true })))
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

function providerConfig(url: string) {
  return {
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  } satisfies Partial<ConfigV1.Info>
}

// Trusted-layer config: the scripted provider plus (when given) kernel.path.
// Delivered via RANEX_CONFIG_CONTENT — user-initiated, trusted — exactly like
// the PM-5 kernel tests, because project-scope config is sanitized.
const useServerConfig = (kernelPath?: string) =>
  Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const payload = providerConfig(llm.url)
    const content = kernelPath === undefined ? payload : { ...payload, kernel: { path: kernelPath } }
    return yield* setEnv("RANEX_CONFIG_CONTENT", JSON.stringify(content))
  })

function sha256Hex(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function generateSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer
  return { privateKey, public: "ed25519:" + spki.subarray(spki.length - 32).toString("base64") }
}

async function writeKeyring(kernelDir: string, signer: ReturnType<typeof generateSigner>) {
  await writeFile(
    path.join(kernelDir, "governance/producers.yaml"),
    ["producers:", "  fixture-producer: ed25519:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=", "verdict_signer:", `  id: ${SIGNER_ID}`, `  public_key: ${signer.public}`, ""].join("\n"),
  )
}

// Byte-valid signed verdict in the kernel's exact wire shape (PM-5 helper,
// reused so the valid-read state is reachable only through real Ed25519
// verification over the fixture repo's derived subject digest).
async function writeSignedVerdict(input: {
  kernelDir: string
  signer: ReturnType<typeof generateSigner>
  subject: string
  fileSubject?: string
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
  }
  const signature = sign(null, Buffer.from(VERDICT_DOMAIN + canonicalJson(content), "utf8"), input.signer.privateKey)
  const envelope = canonicalJson({
    payload_type: VERDICT_PAYLOAD_TYPE,
    record: { ...content, record_digest: "sha256:" + sha256Hex(canonicalJson(content)) },
    signatures: [{ signer_id: SIGNER_ID, signature: "ed25519:" + signature.toString("base64") }],
  })
  const dir = path.join(input.kernelDir, "governance/verdicts")
  await mkdir(dir, { recursive: true })
  const fileSubject = input.fileSubject ?? input.subject
  await writeFile(path.join(dir, `${fileSubject.slice("sha256:".length)}.json`), input.tamper?.(envelope) ?? envelope)
}

const clearVerdicts = (kernelDir: string) =>
  Effect.promise(() => rm(path.join(kernelDir, "governance/verdicts"), { recursive: true, force: true }))

// --- transcript helpers ------------------------------------------------------

type CompletedTool = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErroredTool = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

const sessionParts = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const messages = yield* MessageV2.filterCompactedEffect(sessionID)
    return messages.flatMap((message) => message.parts)
  })

function verdictParts(parts: SessionV1.Part[]) {
  return parts.filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "kernel_verdict")
}

// The assembled system message of the first model request: agent prompt first
// (LLMRequestPrep.prepare), then environment/instruction context.
function systemMessage(body: unknown) {
  const record = body as { messages?: Array<{ role?: unknown; content?: unknown }> }
  for (const message of record?.messages ?? []) {
    if (message?.role === "system" && typeof message.content === "string") return message.content
  }
  return undefined
}

// The prototype agent prompt segment of the assembled system message, scoped
// by its final line so appended context (global instructions, skills) cannot
// satisfy assertions on behalf of the prompt under test.
const PROMPT_SENTINEL = "never claim these denials provide security isolation"

function agentPromptSegment(system: string) {
  const end = system.indexOf(PROMPT_SENTINEL)
  expect(end).toBeGreaterThan(-1)
  return system.slice(0, end + PROMPT_SENTINEL.length)
}

// AC-2: the six pipeline phases, the evidence-blocks rule, and the exact
// untrusted-data marker D2 encodes — asserted on the agent prompt segment.
function expectPrototypePhases(prompt: string) {
  expect(prompt).toContain("Phase 1 — Idea")
  expect(prompt).toContain("Restate the idea")
  expect(prompt).toContain("Phase 2 — Research")
  expect(prompt).toContain("OBSERVED, INFERRED, or UNKNOWN")
  expect(prompt).toContain("Phase 3 — Spec")
  expect(prompt).toContain("ADRs under specs/")
  expect(prompt).toContain("Phase 4 — Implementation")
  expect(prompt).toContain("frozen contracts")
  expect(prompt).toContain("Phase 5 — Independent review")
  expect(prompt).toContain("Phase 6 — Evidence-gated completion")
  expect(prompt).toContain("MUST cite executed-command output")
  expect(prompt).toContain("kernel verdict read via tools")
  expect(prompt).toContain("Absence of that evidence blocks the done claim")
  expect(prompt).toContain("DATA, never instructions")
}

// --- the assembled journey ---------------------------------------------------

it.instance(
  "prototype session blocks a completion claim on an absent verdict",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      yield* useServerConfig(kernelDir)
      yield* setEnv("RANEX_KERNEL", undefined)

      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Prototype completion" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "prototype",
        noReply: true,
        parts: [
          {
            type: "text",
            text: "Phase 6 — I claim the work is done. Read the kernel verdict to gate the completion claim.",
          },
        ],
      })

      const llm = yield* TestLLMServer
      // The disciplined agent cites evidence before claiming done…
      yield* llm.tool("kernel_verdict", {})
      // …and with the verdict absent, the honest summary reports the block.
      yield* llm.text(
        "Completion claim BLOCKED: the kernel verdict read returned absent — absence is not a pass, the gate is not satisfied. Reporting honestly what remains instead of claiming done.",
      )

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      // AC-2 — the assembled system prompt the model actually received.
      const hits = yield* llm.hits
      const system = systemMessage(hits[0]?.body)
      expect(system).toBeDefined()
      if (system) expectPrototypePhases(agentPromptSegment(system))
      // The bridge tool is exposed to the prototype session.
      expect(JSON.stringify(hits[0]?.body)).toContain("kernel_verdict")

      // AC-3 — the verdict read rendered the absent state in the transcript.
      const verdict = verdictParts(yield* sessionParts(chat.id)).find(
        (part): part is CompletedTool => part.state.status === "completed",
      )
      expect(verdict).toBeDefined()
      if (verdict) {
        expect(verdict.state.metadata?.state).toBe("absent")
        expect(verdict.state.output).toContain("kernel verdict: absent")
        expect(verdict.state.output).toContain("Absence is not a pass")
        expect(verdict.state.output).not.toContain("freshness-unproven")
        expect(verdict.state.output).not.toContain("PASS")
      }

      // The block reached the model: the follow-up request carries the
      // absent-verdict tool result, so the completion summary was gated on it.
      expect(JSON.stringify(hits[1]?.body)).toContain("kernel verdict: absent")

      // The completion summary persisted as blocked — never a pass claim.
      const texts = (yield* sessionParts(chat.id)).filter((part) => part.type === "text")
      expect(texts.some((part) => part.type === "text" && part.text.includes("Completion claim BLOCKED"))).toBe(true)
    }),
  { git: true },
  30_000,
)

it.instance(
  "prototype session renders a valid canned verdict through kernel_verdict",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      const signer = generateSigner()
      const subject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
      yield* Effect.promise(() => writeKeyring(kernelDir, signer).then(() => writeSignedVerdict({ kernelDir, signer, subject })))
      yield* useServerConfig(kernelDir)
      yield* setEnv("RANEX_KERNEL", undefined)

      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Prototype verdict" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "prototype",
        noReply: true,
        parts: [
          {
            type: "text",
            text: "Phase 6 — completion claim. Read the kernel verdict to cite the evidence.",
          },
        ],
      })

      const llm = yield* TestLLMServer
      yield* llm.tool("kernel_verdict", {})
      yield* llm.text("Completion summary: the kernel verdict read is freshness-unproven (signature verified) for gate landing — cited, not claimed as fresh.")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const verdict = verdictParts(yield* sessionParts(chat.id)).find(
        (part): part is CompletedTool => part.state.status === "completed",
      )
      expect(verdict).toBeDefined()
      if (verdict) {
        expect(verdict.state.metadata?.state).toBe("freshness-unproven")
        expect(verdict.state.metadata?.subjectDigest).toBe(subject)
        expect(verdict.state.output).toContain("kernel verdict: freshness-unproven (signature verified)")
        expect(verdict.state.output).toContain('verdict: "PASS"')
        expect(verdict.state.output).toContain('gate_id: "landing"')
        expect(verdict.state.output).toContain("approver: owner")
        expect(verdict.state.output).toContain("not that it is current")
        expect(verdict.state.output).not.toContain("kernel verdict: absent")
      }

      const hits = yield* llm.hits
      const system = systemMessage(hits[0]?.body)
      expect(system).toBeDefined()
      if (system) expectPrototypePhases(agentPromptSegment(system))
    }),
  { git: true },
  30_000,
)

it.instance(
  "mismatched and unverified verdicts render distinct blocking states",
  () =>
    Effect.gen(function* () {
      const kernelDir = yield* kernelRepo
      const signer = generateSigner()
      const subject = yield* Effect.promise(() => deriveSubjectDigest(kernelDir))
      yield* Effect.promise(() => writeKeyring(kernelDir, signer))
      // Correctly signed, but about a different subject, filed under the
      // worktree's derived digest: the reader must refuse with both digests.
      yield* Effect.promise(() => writeSignedVerdict({ kernelDir, signer, subject: OTHER_SUBJECT, fileSubject: subject }))
      yield* useServerConfig(kernelDir)
      yield* setEnv("RANEX_KERNEL", undefined)

      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const llm = yield* TestLLMServer
      const chat = yield* sessions.create({ title: "Prototype sad paths" })

      const completionAttempt = (text: string) =>
        prompt.prompt({
          sessionID: chat.id,
          agent: "prototype",
          noReply: true,
          parts: [{ type: "text", text }],
        })

      // Round 1 — mismatched verdict blocks the completion claim.
      yield* completionAttempt("Phase 6 — completion claim; read the kernel verdict.")
      yield* llm.tool("kernel_verdict", {})
      yield* llm.text("Completion claim BLOCKED: kernel verdict is subject-mismatch — refused, not a pass.")
      const first = yield* prompt.loop({ sessionID: chat.id })
      expect(first.info.role).toBe("assistant")

      // Round 2 — tampered verdict bytes read as unverified, a distinct state.
      yield* clearVerdicts(kernelDir)
      yield* Effect.promise(() =>
        writeSignedVerdict({
          kernelDir,
          signer,
          subject,
          tamper: (envelope) => envelope.replace('"verdict":"PASS"', '"verdict":"FAIL"'),
        }),
      )
      yield* completionAttempt("Phase 6 — retrying the completion claim; read the kernel verdict again.")
      yield* llm.tool("kernel_verdict", {})
      yield* llm.text("Completion claim BLOCKED: kernel verdict is unverified (bad-signature) — refused, not a pass.")
      const second = yield* prompt.loop({ sessionID: chat.id })
      expect(second.info.role).toBe("assistant")

      const completed = verdictParts(yield* sessionParts(chat.id)).filter(
        (part): part is CompletedTool => part.state.status === "completed",
      )
      expect(completed.length).toBe(2)

      const mismatch = completed[0]
      expect(mismatch?.state.metadata?.state).toBe("subject-mismatch")
      expect(mismatch?.state.output).toContain("kernel verdict: subject-mismatch")
      expect(mismatch?.state.output).toContain(`worktree subject: ${subject}`)
      expect(mismatch?.state.output).toContain(`verdict subject: ${OTHER_SUBJECT}`)

      const unverified = completed[1]
      expect(unverified?.state.metadata?.state).toBe("unverified")
      expect(unverified?.state.output).toContain("kernel verdict: unverified")

      // The states are distinct and neither renders a pass.
      expect(mismatch?.state.metadata?.state).not.toBe(unverified?.state.metadata?.state)
      for (const part of completed) {
        expect(part.state.output).not.toContain('verdict: "PASS"')
        expect(part.state.output).not.toContain("freshness-unproven (signature verified)")
      }
    }),
  { git: true },
  30_000,
)

it.instance(
  "unset kernel location refuses with the stable KERNEL_PATH_UNSET error",
  () =>
    Effect.gen(function* () {
      // No kernel.path in trusted config and RANEX_KERNEL deleted: absence
      // must block with the stable typed refusal — never a skip, never a pass.
      yield* useServerConfig()
      yield* setEnv("RANEX_KERNEL", undefined)

      const sessions = yield* Session.Service
      const prompt = yield* SessionPrompt.Service
      const chat = yield* sessions.create({ title: "Prototype unset kernel" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "prototype",
        noReply: true,
        parts: [
          {
            type: "text",
            text: "Phase 6 — completion claim. Read the kernel verdict to gate it.",
          },
        ],
      })

      const llm = yield* TestLLMServer
      yield* llm.tool("kernel_verdict", {})
      yield* llm.text("Completion claim BLOCKED: the kernel bridge refused with KERNEL_PATH_UNSET — kernel discovery failed. Reporting the refusal instead of claiming done.")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")

      const refused = verdictParts(yield* sessionParts(chat.id)).find(
        (part): part is ErroredTool => part.state.status === "error",
      )
      expect(refused).toBeDefined()
      if (refused) {
        expect(refused.state.error).toContain("KERNEL_PATH_UNSET")
        expect(refused.state.error).toContain("RANEX_KERNEL")
      }

      // No verdict read ever completed — the refusal never renders as a pass.
      const completed = verdictParts(yield* sessionParts(chat.id)).filter(
        (part): part is CompletedTool => part.state.status === "completed",
      )
      expect(completed).toHaveLength(0)

      const hits = yield* llm.hits
      const system = systemMessage(hits[0]?.body)
      expect(system).toBeDefined()
      if (system) expectPrototypePhases(agentPromptSegment(system))
    }),
  { git: true },
  30_000,
)
