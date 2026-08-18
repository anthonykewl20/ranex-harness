import { ConfigV1 } from "@ranex/core/v1/config/config"
import { Database } from "@ranex/core/database/database"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { SessionProjector } from "@ranex/core/session/projector"
import { expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "../../src/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@ranex/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { CrossSpawnSpawner } from "@ranex/core/cross-spawn-spawner"
import { Ripgrep } from "@ranex/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@ranex/core/provider"
import { ModelV2 } from "@ranex/core/model"
import { EventV2Bridge } from "@/event-v2-bridge"

// Regression coverage for the commandTemplate caller-owned-message guard:
// a caller-supplied messageID that already belongs to a persisted user
// message must never be reused by the optimistic echo (clobber on update,
// permanent deletion on template failure), while a free messageID is still
// adopted.

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

const stub: { calls: number; template: string | undefined; gate?: Promise<void> } = {
  calls: 0,
  template: "STUB TEMPLATE $1",
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () =>
      Effect.succeed({
        "slow:review": {
          name: "review",
          client: "slow",
          description: "slow server prompt",
          arguments: [{ name: "topic", description: "review topic", required: true }],
        },
      }),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    onReconnect: () => Effect.succeed(() => {}),
    getPrompt: () =>
      Effect.gen(function* () {
        stub.calls++
        const gate = stub.gate
        if (gate) yield* Effect.promise(() => gate)
        const template = stub.template
        if (template === undefined) return undefined
        return { messages: [{ role: "user" as const, content: { type: "text" as const, text: template } }] }
      }),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-echo-guard tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-echo-guard tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-echo-guard tests"),
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

const echoGuard = testEffect(
  LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), [
    [SessionSummary.node, summary],
    [LSP.node, lsp],
    [MCP.node, mcp],
    [RuntimeFlags.node, runtimeFlags],
  ] as const),
)

const resetStub = Effect.addFinalizer(() =>
  Effect.sync(() => {
    stub.calls = 0
    stub.template = "STUB TEMPLATE $1"
    stub.gate = undefined
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
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
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

const providerCfg = (url: string) => ({
  ...cfg,
  provider: {
    ...cfg.provider,
    test: {
      ...cfg.provider.test,
      options: {
        ...cfg.provider.test.options,
        baseURL: url,
      },
    },
  },
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const llm = yield* TestLLMServer
  const previous = process.env.RANEX_CONFIG_CONTENT
  process.env.RANEX_CONFIG_CONTENT = JSON.stringify(config(llm.url))
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (previous === undefined) delete process.env.RANEX_CONFIG_CONTENT
      else process.env.RANEX_CONFIG_CONTENT = previous
    }),
  )
  return { llm }
})

echoGuard.instance(
  "template failure with a taken caller messageID never deletes or clobbers the caller's message",
  () =>
    Effect.gen(function* () {
      yield* resetStub
      stub.template = undefined

      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      const callerID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: callerID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: callerID,
        sessionID: chat.id,
        type: "text",
        text: "caller-owned payload",
      })
      // The guard checks persisted state, so wait until the caller's message
      // is actually projected before driving the command.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* sessions.messages({ sessionID: chat.id })
          return msgs.some((msg) => msg.info.id === callerID) ? true : undefined
        }),
        "caller-owned message never became visible",
      )

      const exit = yield* prompt
        .command({ sessionID: chat.id, command: "slow:review", arguments: "", messageID: callerID })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* llm.calls).toBe(0)

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      // The caller's message survived intact: same row, same agent, same part.
      const original = msgs.find((msg) => msg.info.id === callerID)
      expect(original).toBeDefined()
      expect(original?.info.role).toBe("user")
      expect(original?.info.agent).toBe("build")
      expect(original?.parts.some((part) => part.type === "text" && part.text === "caller-owned payload")).toBe(true)
      // The transient echo was minted on a fresh ID and cleaned up: no stray
      // user row, no placeholder part.
      expect(msgs.filter((msg) => msg.info.role === "user")).toHaveLength(1)
      expect(
        msgs.some((msg) =>
          msg.parts.some((part) => part.type === "text" && part.text.includes(`Loading "/slow:review"`)),
        ),
      ).toBe(false)
    }),
  30_000,
)

echoGuard.instance(
  "free caller messageID is still adopted by the optimistic echo",
  () =>
    Effect.gen(function* () {
      yield* resetStub
      stub.template = "ADOPT TEMPLATE $1"
      // Park getPrompt on a promise the test controls, so the pending window
      // is observed deterministically instead of racing a fixed sleep.
      let release!: () => void
      stub.gate = new Promise<void>((done) => {
        release = done
      })

      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      const freshID = MessageID.ascending()
      yield* llm.text("done")
      const command = yield* prompt
        .command({ sessionID: chat.id, command: "slow:review", arguments: "the-topic", messageID: freshID })
        .pipe(Effect.forkChild)

      // While getPrompt is parked, the optimistic echo must exist under the
      // caller's (free) messageID with the placeholder part on it.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* sessions.messages({ sessionID: chat.id })
          return msgs.some(
            (msg) =>
              msg.info.id === freshID &&
              msg.parts.some((part) => part.type === "text" && part.text.includes(`Loading "/slow:review"`)),
          )
            ? true
            : undefined
        }),
        "echo never adopted the caller's messageID",
      )

      release()
      const exit = yield* Fiber.await(command)
      expect(Exit.isSuccess(exit)).toBe(true)

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const adopted = msgs.find((msg) => msg.info.id === freshID)
      expect(
        adopted?.parts.some((part) => part.type === "text" && part.text.includes("ADOPT TEMPLATE the-topic")),
      ).toBe(true)
      expect(
        msgs.some((msg) =>
          msg.parts.some((part) => part.type === "text" && part.text.includes(`Loading "/slow:review"`)),
        ),
      ).toBe(false)
    }),
  30_000,
)

echoGuard.instance(
  "taken caller messageID with successful template keeps caller intact and lands template on a fresh ID",
  () =>
    Effect.gen(function* () {
      yield* resetStub
      stub.template = "TAKEN SUCCESS $1"
      // Park getPrompt so the template is still pending when commandTemplate
      // runs — the string-template early return path deliberately forwards
      // the caller's messageID (exact-retry reconciliation), so the guard is
      // only observable while the template is unresolved.
      let release!: () => void
      stub.gate = new Promise<void>((done) => {
        release = done
      })

      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      const callerID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: callerID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: callerID,
        sessionID: chat.id,
        type: "text",
        text: "caller-owned payload",
      })
      // The guard reads persisted state, so wait until the caller's message
      // is projected before driving the command.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* sessions.messages({ sessionID: chat.id })
          return msgs.some((msg) => msg.info.id === callerID) ? true : undefined
        }),
        "caller-owned message never became visible",
      )

      yield* llm.text("done")
      const command = yield* prompt
        .command({ sessionID: chat.id, command: "slow:review", arguments: "the-topic", messageID: callerID })
        .pipe(Effect.forkChild)
      // While parked, the echo must already live on a fresh ID: the
      // placeholder appears under a messageID the caller does not own.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* sessions.messages({ sessionID: chat.id })
          return msgs.some(
            (msg) =>
              msg.info.id !== callerID &&
              msg.parts.some((part) => part.type === "text" && part.text.includes(`Loading "/slow:review"`)),
          )
            ? true
            : undefined
        }),
        "echo never minted a fresh messageID",
      )

      release()
      const exit = yield* Fiber.await(command)
      expect(Exit.isSuccess(exit)).toBe(true)

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      // The caller's message survived intact: same row, same agent, same part.
      const original = msgs.find((msg) => msg.info.id === callerID)
      expect(original).toBeDefined()
      expect(original?.info.role).toBe("user")
      expect(original?.info.agent).toBe("build")
      expect(original?.parts.some((part) => part.type === "text" && part.text === "caller-owned payload")).toBe(true)
      // The template landed under a fresh messageID — the success-path return
      // and the persisted row agree on it.
      const landed = msgs.find((msg) =>
        msg.parts.some((part) => part.type === "text" && part.text.includes("TAKEN SUCCESS the-topic")),
      )
      // command() resolves with the loop's final assistant message, not the
      // user row; the landed row above is the fresh-ID echo from the guard.
      if (Exit.isSuccess(exit)) expect(exit.value.info.role).toBe("assistant")
      expect(landed?.info.id).not.toBe(callerID)
      expect(
        msgs.some((msg) =>
          msg.parts.some((part) => part.type === "text" && part.text.includes(`Loading "/slow:review"`)),
        ),
      ).toBe(false)
      // Two-row semantics: the caller's message plus the landed template.
      expect(msgs.filter((msg) => msg.info.role === "user")).toHaveLength(2)
    }),
  30_000,
)
