// G-3: drive the three GitHub tools through the real provider-facing
// serialization path — SessionTools.resolve → ToolJsonSchema.fromTool →
// LLMRequestPrep.prepare → streamText → the loopback LLM server — and pin
// the outgoing request `tools` body. Loopback-only, no network, no mocks of
// the serialization itself.

import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Database } from "@ranex/core/database/database"
import { SessionProjector } from "@ranex/core/session/projector"
import { FSUtil } from "@ranex/core/fs-util"
import { Ripgrep } from "@ranex/core/ripgrep"
import { CrossSpawnSpawner } from "@ranex/core/cross-spawn-spawner"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "../../src/background/job"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { LSP } from "../../src/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "../../src/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { Format } from "../../src/format"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

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
    startAuth: () => Effect.die("unexpected MCP auth in provider-serialization test"),
    authenticate: () => Effect.die("unexpected MCP auth in provider-serialization test"),
    finishAuth: () => Effect.die("unexpected MCP auth in provider-serialization test"),
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
  Agent.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  Provider.node,
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

const layer = LayerNode.compile(LayerNode.group([promptRoot, testLLMServerNode]), [
  [SessionSummary.node, summary],
  [LSP.node, lsp],
  [MCP.node, mcp],
  [RuntimeFlags.node, runtimeFlags],
])

const it = testEffect(layer)

// Registers a custom "test" provider pointing at the loopback server; the
// config is delivered via RANEX_CONFIG_CONTENT because project-scope config
// is sanitized.
const providerCfg = (url: string) => ({
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
        baseURL: url,
      },
    },
  },
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => object) {
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

type WireTool = { name: string; parameters: Record<string, unknown> }

function wireTools(body: Record<string, unknown>): WireTool[] {
  const tools = body.tools
  if (!Array.isArray(tools)) return []
  return tools.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return []
    const fn = (entry as { function?: unknown }).function
    if (typeof fn !== "object" || fn === null) return []
    const name = (fn as { name?: unknown }).name
    const parameters = (fn as { parameters?: unknown }).parameters
    if (typeof name !== "string" || typeof parameters !== "object" || parameters === null) return []
    return [{ name, parameters: parameters as Record<string, unknown> }]
  })
}

it.instance(
  "outgoing tools body carries object-rooted GitHub tool schemas with constraints intact",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      expect(yield* llm.calls).toBe(1)

      const body = (yield* llm.inputs)[0]
      if (!body) throw new Error("expected an LLM request body")
      const github = wireTools(body).filter((tool) => tool.name.startsWith("github_"))
      expect(github.map((tool) => tool.name)).toEqual(["github_issue", "github_milestone", "github_project"])

      for (const tool of github) {
        expect(tool.parameters.type, `${tool.name} root type`).toBe("object")
        expect(Array.isArray(tool.parameters.anyOf), `${tool.name} keeps its action union`).toBe(true)
      }

      const issue = github.find((tool) => tool.name === "github_issue")
      expect(issue?.parameters).toMatchObject({
        type: "object",
        anyOf: [
          { type: "object", properties: { action: { enum: ["list"] } } },
          {
            type: "object",
            properties: {
              action: { enum: ["get"] },
              // property-level unions stay as anyOf inside properties
              number: { anyOf: [{ type: "integer" }, { type: "string" }] },
            },
          },
          { type: "object", properties: { action: { enum: ["create"] } } },
          { type: "object", properties: { action: { enum: ["update"] } } },
          { type: "object", properties: { action: { enum: ["close"] } } },
          { type: "object", properties: { action: { enum: ["comment"] } } },
        ],
      })
    }),
)
