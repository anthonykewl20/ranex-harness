import { describe, expect, test } from "bun:test"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Tool } from "@opencode-ai/core/tool/tool"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/core/location"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { createLLMEventPublisher } from "@opencode-ai/core/session/runner/publish-llm-event"
import { Effect, Layer, Schema, Stream } from "effect"
import type * as Scope from "effect/Scope"
import { eq } from "drizzle-orm"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sessionID = SessionV2.ID.make("ses_reconciler_test")

// A fake client is required to build the runner layer; no provider turn runs in
// these tests, so it never streams.
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: (() => Stream.empty) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
let currentModel = model
const models = SessionRunnerModel.layerWith(() => Effect.succeed(currentModel))
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const tools = Layer.effectDiscard(
  ToolRegistry.Service.pipe(Effect.flatMap((registry) => registry.register({}))),
)
const toolsNode = makeLocationNode({ name: "test/reconciler-tools", layer: tools, deps: [ToolRegistry.node] })
const systemContextKey = SystemContext.Key.make("test/context")
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine([
            SystemContext.make({
              key: systemContextKey,
              codec: Schema.toCodecJson(Schema.String),
              load: Effect.succeed("Initial context"),
              baseline: String,
              update: (_previous, current) => current,
              removed: () => "System context source removed: test/context",
            }),
          ]),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)

let dbFile: string
const buildLayer = () =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      toolsNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
    ]),
    [
      [Database.node, Database.layerFromPath(dbFile)],
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [Config.node, config],
    ],
  )

// Run one program in a fresh Effect scope against the layer, then tear the scope
// down. Each call is one "graph"; a file DB carries projected state across them.
// R is fixed by the layer so the program's requirements (a subset) typecheck.
const runInGraph = <A, E, E2, R>(layer: Layer.Layer<R, E2>, program: Effect.Effect<A, E, Scope.Scope | R>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer)))

const insertSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

// Graph 1 fixture: emit the durable events a provider turn leaves behind when the
// process is killed AFTER a tool is called but BEFORE it settles. The projector
// writes an assistant message with one tool projected "running". No Tool.Success
// or Tool.Failed is ever published. This is the exact post-SIGKILL durable state.
const buildStrandedToolFixture = Effect.gen(function* () {
  yield* insertSession
  const events = yield* EventV2.Service
  const publisher = createLLMEventPublisher(events, {
    sessionID,
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
  })
  yield* publisher.publish(LLMEvent.toolInputStart({ id: "call-stranded", name: "echo" }))
  yield* publisher.publish(LLMEvent.toolInputEnd({ id: "call-stranded", name: "echo" }))
  yield* publisher.publish(LLMEvent.toolCall({ id: "call-stranded", name: "echo", input: { text: "hi" } }))
})

const assistantTool = (messages: ReadonlyArray<SessionMessage.Message>) => {
  const assistant = messages.find((message) => message.type === "assistant")
  if (!assistant || assistant.type !== "assistant") throw new Error("no assistant message projected")
  const tool = assistant.content.find((content) => content.type === "tool")
  if (!tool || tool.type !== "tool") throw new Error("no tool projected")
  return tool
}

const toolFailedEventCount = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Tool.Failed.type, 1)))
    .all()
    .pipe(Effect.orDie)
  return rows.length
})

describe("SLICE-011 claim 2 — reconciler reorder (empty-inbox crash)", () => {
  test("graph teardown leaves the tool projected running across a fresh graph", async () => {
    dbFile = join(mkdtempSync(join(tmpdir(), "ranex-rec-")), "rec.db")
    const layer = buildLayer()
    try {
      await runInGraph(layer, buildStrandedToolFixture)
      // Graph 2: a fresh graph reopens the same durable projection.
      await runInGraph(
        layer,
        Effect.gen(function* () {
          const store = yield* SessionStore.Service
          const context = yield* store.context(sessionID)
          expect(assistantTool(context).state.status).toBe("running")
        }),
      )
    } finally {
      rmSync(join(dbFile, ".."), { recursive: true, force: true })
    }
  })

  test("RED->GREEN: run with an empty inbox reconciles the stranded tool", async () => {
    dbFile = join(mkdtempSync(join(tmpdir(), "ranex-rec-")), "rec.db")
    const layer = buildLayer()
    try {
      await runInGraph(layer, buildStrandedToolFixture)
      await runInGraph(
        layer,
        Effect.gen(function* () {
          const store = yield* SessionStore.Service
          const runner = yield* SessionRunner.Service
          const { db } = yield* Database.Service
          // Baseline: the crash left the tool running, and the inbox is empty.
          expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("running")
          expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(false)
          expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(false)
          // The whole point: run with an empty inbox must still reconcile.
          yield* runner.run({ sessionID, force: false })
          expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("error")
        }),
      )
    } finally {
      rmSync(join(dbFile, ".."), { recursive: true, force: true })
    }
  })

  test("GREEN: the startup sweep (reconcile) marks the stranded tool interrupted", async () => {
    dbFile = join(mkdtempSync(join(tmpdir(), "ranex-rec-")), "rec.db")
    const layer = buildLayer()
    try {
      await runInGraph(layer, buildStrandedToolFixture)
      await runInGraph(
        layer,
        Effect.gen(function* () {
          const store = yield* SessionStore.Service
          const runner = yield* SessionRunner.Service
          expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("running")
          yield* runner.reconcile(sessionID)
          expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("error")
        }),
      )
    } finally {
      rmSync(join(dbFile, ".."), { recursive: true, force: true })
    }
  })

  test("idempotency: reconciling twice produces no second message, attempt, or effect", async () => {
    dbFile = join(mkdtempSync(join(tmpdir(), "ranex-rec-")), "rec.db")
    const layer = buildLayer()
    try {
      await runInGraph(layer, buildStrandedToolFixture)
      await runInGraph(
        layer,
        Effect.gen(function* () {
          const store = yield* SessionStore.Service
          const runner = yield* SessionRunner.Service
          yield* runner.reconcile(sessionID)
          const afterFirst = assistantTool(yield* store.context(sessionID))
          expect(afterFirst.state.status).toBe("error")
          const eventsBefore = yield* toolFailedEventCount
          expect(eventsBefore).toBe(1)
          // Second reconciliation: the tool is no longer pending/running, so nothing fires.
          yield* runner.reconcile(sessionID)
          yield* runner.run({ sessionID, force: false })
          const afterSecond = assistantTool(yield* store.context(sessionID))
          expect(afterSecond.state.status).toBe("error")
          const eventsAfter = yield* toolFailedEventCount
          expect(eventsAfter).toBe(eventsBefore)
        }),
      )
    } finally {
      rmSync(join(dbFile, ".."), { recursive: true, force: true })
    }
  })
})
