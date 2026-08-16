import { describe, expect, test } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMClientShape } from "@ranex/llm"
import * as OpenAIChat from "@ranex/llm/protocols/openai-chat"
import { Database } from "@ranex/core/database/database"
import { makeLocationNode } from "@ranex/core/effect/app-node"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ranex/core/effect/app-node-platform"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { EventV2 } from "@ranex/core/event"
import { EventTable } from "@ranex/core/event/sql"
import { PermissionV2 } from "@ranex/core/permission"
import { Project } from "@ranex/core/project"
import { ProjectTable } from "@ranex/core/project/sql"
import { QuestionV2 } from "@ranex/core/question"
import { AbsolutePath } from "@ranex/core/schema"
import { SessionV2 } from "@ranex/core/session"
import { Snapshot } from "@ranex/core/snapshot"
import { SessionEvent } from "@ranex/core/session/event"
import { SessionInput } from "@ranex/core/session/input"
import { SessionMessage } from "@ranex/core/session/message"
import { SessionProjector } from "@ranex/core/session/projector"
import { SessionStore } from "@ranex/core/session/store"
import { SessionExecution } from "@ranex/core/session/execution"
import { SessionRunner } from "@ranex/core/session/runner"
import * as SessionRunnerLLM from "@ranex/core/session/runner/llm"
import { SessionRunnerModel } from "@ranex/core/session/runner/model"
import { SessionTurnLLM } from "@ranex/core/session/runner/turn-llm"
import { SessionReconcile } from "@ranex/core/session/reconcile"
import { createLLMEventPublisher } from "@ranex/core/session/runner/publish-llm-event"
import { ToolRegistry } from "@ranex/core/tool/registry"
import { ApplicationTools } from "@ranex/core/tool/application-tools"
import { AgentV2 } from "@ranex/core/agent"
import { Config } from "@ranex/core/config"
import { ConfigCompaction } from "@ranex/core/config/compaction"
import { Tool } from "@ranex/core/tool/tool"
import { SessionTable } from "@ranex/core/session/sql"
import { SystemContext } from "@ranex/core/system-context"
import { SystemContextRegistry } from "@ranex/core/system-context/registry"
import { SkillGuidance } from "@ranex/core/skill/guidance"
import { ReferenceGuidance } from "@ranex/core/reference/guidance"
import { ModelV2 } from "@ranex/core/model"
import { Location } from "@ranex/core/location"
import { ProviderV2 } from "@ranex/core/provider"
import { Effect, Layer, Schema, Stream } from "effect"
import type * as Scope from "effect/Scope"
import { eq } from "drizzle-orm"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sessionID = SessionV2.ID.make("ses_reconciler_test")

// A fake client is required to build the runner layer; no provider turn runs in
// these tests, so it never streams. The `stream` reference is watched to prove
// the sweep reconciles without scheduling a provider turn.
let streamCallCount = 0
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: (() => {
      streamCallCount++
      return Stream.empty
    }) as unknown as LLMClientShape["stream"],
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
      [SessionTurnLLM.node, SessionTurnLLM.layerFrom(client)],
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
const runInGraph = <A, E, E2, R>(layer: Layer.Layer<R, E2>, program: Effect.Effect<A, E, Scope.Scope | R>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer)))

// A graph that only wires the durable globals + the startup sweep node. Building
// this layer IS process boot for the sweep: the discard effect runs once during
// construction and reconciles every session in the file DB. No runner, no run().
const buildSweepLayer = () =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionExecution.node,
      SessionReconcile.sweepNode,
    ]),
    [[Database.node, Database.layerFromPath(dbFile)], [SessionExecution.node, SessionExecution.noopLayer]],
  )

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

describe("SLICE-013 reconciler reorder (empty-inbox crash)", () => {
  test("graph teardown leaves the tool projected running across a fresh graph", async () => {
    dbFile = join(mkdtempSync(join(tmpdir(), "ranex-rec-")), "rec.db")
    const layer = buildLayer()
    try {
      await runInGraph(layer, buildStrandedToolFixture)
      await runInGraph(
        layer,
        Effect.gen(function* () {
          const store = yield* SessionStore.Service
          expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("running")
        }),
      )
    } finally {
      rmSync(join(dbFile, ".."), { recursive: true, force: true })
    }
  })

  test("RED: run with an empty inbox must reconcile the stranded tool", async () => {
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
          // The crash left the tool running, and the inbox is empty for BOTH
          // steer and queue — a pending steer masks the bug entirely.
          expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("running")
          expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(false)
          expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(false)
          // The whole point: run with an empty inbox must still reconcile.
          yield* runner.run({ sessionID, force: false })
          expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("error")
          expect(assistantTool(yield* store.context(sessionID)).provider?.executed).toBe(false)
        }),
      )
    } finally {
      rmSync(join(dbFile, ".."), { recursive: true, force: true })
    }
  })

  test("the hoist reconciles but an empty-inbox run performs no provider turn", async () => {
    streamCallCount = 0
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
          expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(false)
          expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(false)
          yield* runner.run({ sessionID, force: false })
          // The stranded tool is reconciled...
          expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("error")
          // ...but the eligible-input guard still short-circuits: no provider turn.
          expect(streamCallCount).toBe(0)
        }),
      )
    } finally {
      rmSync(join(dbFile, ".."), { recursive: true, force: true })
    }
  })

  test("the reconcile capability marks the stranded tool interrupted", async () => {
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

  test("idempotency: reconciling twice produces exactly one durable Tool.Failed row", async () => {
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
          expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("error")
          // Count durable Tool.Failed ROWS, not tool status: the projector
          // re-checks the same guard so projected state is idempotent even under
          // a duplicate event — only the durable row count catches a double publish.
          expect(yield* toolFailedEventCount).toBe(1)
          // Second reconciliation and an empty-inbox run: the tool is no longer
          // pending/running, so nothing fires.
          yield* runner.reconcile(sessionID)
          yield* runner.run({ sessionID, force: false })
          expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("error")
          expect(yield* toolFailedEventCount).toBe(1)
        }),
      )
    } finally {
      rmSync(join(dbFile, ".."), { recursive: true, force: true })
    }
  })

  test("concurrent reconcile and run serialize to exactly one Tool.Failed row", async () => {
    dbFile = join(mkdtempSync(join(tmpdir(), "ranex-rec-")), "rec.db")
    const layer = buildLayer()
    try {
      await runInGraph(layer, buildStrandedToolFixture)
      await runInGraph(
        layer,
        Effect.gen(function* () {
          const runner = yield* SessionRunner.Service
          // Launch reconcile and an empty-inbox run concurrently. Both call
          // failInterruptedTools and both can read the tool as `running`. The
          // per-session mutex must serialize them so only one publishes.
          // concurrency: 2 is required — Effect.all defaults to sequential (1).
          yield* Effect.all([runner.reconcile(sessionID), runner.run({ sessionID, force: false })], {
            concurrency: 2,
          })
          expect(yield* toolFailedEventCount).toBe(1)
        }),
      )
    } finally {
      rmSync(join(dbFile, ".."), { recursive: true, force: true })
    }
  })

  test("the startup sweep reconciles a stranded tool with no run() call", async () => {
    dbFile = join(mkdtempSync(join(tmpdir(), "ranex-rec-")), "rec.db")
    const layer = buildLayer()
    const sweepLayer = buildSweepLayer()
    try {
      // Graph 1: a crash leaves a tool projected running, inbox empty.
      await runInGraph(layer, buildStrandedToolFixture)
      // Graph 2: process boot. Building the sweep layer runs the sweep over all
      // sessions. Nobody calls run(); the sweep reconciles directly.
      await runInGraph(sweepLayer, Effect.void)
      // Graph 3: the stranded tool is recovered with exactly one durable failure.
      await runInGraph(
        layer,
        Effect.gen(function* () {
          const store = yield* SessionStore.Service
          const { db } = yield* Database.Service
          expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(false)
          expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(false)
          expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("error")
          expect(yield* toolFailedEventCount).toBe(1)
        }),
      )
    } finally {
      rmSync(join(dbFile, ".."), { recursive: true, force: true })
    }
  })
})
