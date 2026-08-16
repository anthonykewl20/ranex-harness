import { expect, test } from "bun:test"
import { LLMClient, LLMEvent, Model } from "@ranex/llm"
import { route } from "@ranex/llm/protocols/openai-chat"
import { AgentV2 } from "@ranex/core/agent"
import { Config } from "@ranex/core/config"
import { ConfigCompaction } from "@ranex/core/config/compaction"
import { Database } from "@ranex/core/database/database"
import { makeLocationNode } from "@ranex/core/effect/app-node"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ranex/core/effect/app-node-platform"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { EventV2 } from "@ranex/core/event"
import { EventTable } from "@ranex/core/event/sql"
import { Location } from "@ranex/core/location"
import { ModelV2 } from "@ranex/core/model"
import { PermissionV2 } from "@ranex/core/permission"
import { Project } from "@ranex/core/project"
import { ProjectTable } from "@ranex/core/project/sql"
import { ProviderV2 } from "@ranex/core/provider"
import { QuestionV2 } from "@ranex/core/question"
import { AbsolutePath } from "@ranex/core/schema"
import { ReferenceGuidance } from "@ranex/core/reference/guidance"
import { SessionV2 } from "@ranex/core/session"
import { SessionEvent } from "@ranex/core/session/event"
import { ExecutionOwner } from "@ranex/core/session/execution-owner"
import { SessionMessage } from "@ranex/core/session/message"
import { SessionProjector } from "@ranex/core/session/projector"
import { SessionReconcile } from "@ranex/core/session/reconcile"
import { SessionRunCoordinator } from "@ranex/core/session/run-coordinator"
import { SessionRunner } from "@ranex/core/session/runner"
import { node } from "@ranex/core/session/runner/llm"
import { SessionRunnerModel } from "@ranex/core/session/runner/model"
import { SessionTurnLLM } from "@ranex/core/session/runner/turn-llm"
import { createLLMEventPublisher } from "@ranex/core/session/runner/publish-llm-event"
import { SessionStore } from "@ranex/core/session/store"
import { SessionTable } from "@ranex/core/session/sql"
import { EffectFlock } from "@ranex/core/util/effect-flock"
import { SkillGuidance } from "@ranex/core/skill/guidance"
import { Snapshot } from "@ranex/core/snapshot"
import { SystemContext } from "@ranex/core/system-context"
import { SystemContextRegistry } from "@ranex/core/system-context/registry"
import { ApplicationTools } from "@ranex/core/tool/application-tools"
import { ToolRegistry } from "@ranex/core/tool/registry"
import { Clock, DateTime, Effect, Layer, Schema, Scope, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const worker = join(import.meta.dir, "fixture/reconcile-fence-worker.ts")
// Each case cold-starts one or more Bun worker processes while the core suite runs test files in parallel; matches the budget used by ownership-fence.test.ts.
const workerTestTimeout = 30_000

const client = Layer.mock(LLMClient.Service, {
  prepare: () => Effect.die("unused"),
  stream: () => Stream.empty,
  generate: () => Effect.die("unused"),
})
let providerCalls = 0
const providerCallTimes: number[] = []
const recoveryClient = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: () =>
      Stream.unwrap(
        Clock.currentTimeMillis.pipe(
          Effect.tap((time) => Effect.sync(() => {
            providerCalls++
            providerCallTimes.push(time)
          })),
          Effect.as(Stream.empty),
        ),
      ),
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const permission = Layer.mock(PermissionV2.Service, {
  assert: () => Effect.die("unused"),
  ask: () => Effect.die("unused"),
  reply: () => Effect.die("unused"),
  get: () => Effect.die("unused"),
  forSession: () => Effect.die("unused"),
  list: () => Effect.die("unused"),
})
const tools = Layer.effectDiscard(ToolRegistry.Service.pipe(Effect.flatMap((registry) => registry.register({}))))
const toolsNode = makeLocationNode({ name: "test/reconcile-fence-tools", layer: tools, deps: [ToolRegistry.node] })
const systemContextKey = SystemContext.Key.make("test/reconcile-fence-context")
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
              removed: () => "System context source removed: test/reconcile-fence-context",
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

const runInGraph = <A, E, E2, R>(layer: Layer.Layer<R, E2>, program: Effect.Effect<A, E, Scope.Scope | R>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer)))

function buildSeedLayer(dbFile: string) {
  return AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, EffectFlock.node]),
    [[Database.node, Database.layerFromPath(dbFile)]],
  )
}

function buildRunnerLayer(dbFile: string, llmClient = client) {
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      EffectFlock.node,
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
      node,
    ]),
    [
      [Database.node, Database.layerFromPath(dbFile)],
      [LayerNodePlatform.llmClient, llmClient],
      [SessionTurnLLM.node, SessionTurnLLM.layerFrom(llmClient)],
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
}

function seedStrandedTool(sessionID: SessionV2.ID, settled = false) {
  return Effect.gen(function* () {
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
    const events = yield* EventV2.Service
    const publisher = createLLMEventPublisher(events, {
      sessionID,
      agent: "build",
      model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    })
    yield* publisher.publish(LLMEvent.toolInputStart({ id: "call-stranded", name: "echo" }))
    yield* publisher.publish(LLMEvent.toolInputEnd({ id: "call-stranded", name: "echo" }))
    yield* publisher.publish(LLMEvent.toolCall({ id: "call-stranded", name: "echo", input: { text: "hi" } }))
    if (!settled) return
    yield* publisher.publish(
      LLMEvent.toolResult({
        id: "call-stranded",
        name: "echo",
        result: { type: "content", value: [{ type: "text", text: "ok" }] },
        output: { structured: { text: "ok" }, content: [{ type: "text", text: "ok" }] },
      }),
    )
  })
}

function assistantTool(messages: ReadonlyArray<SessionMessage.Message>) {
  const assistant = messages.find((message) => message.type === "assistant")
  if (!assistant || assistant.type !== "assistant") throw new Error("no assistant message projected")
  const tool = assistant.content.find((content) => content.type === "tool")
  if (!tool || tool.type !== "tool") throw new Error("no tool projected")
  return tool
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function currentExecutionIdentity() {
  const bootID = await ExecutionOwner.readBootId()
  const startTime = await ExecutionOwner.readStartTime(process.pid)
  if (bootID === undefined || startTime === undefined) throw new Error("Current process identity is unavailable")
  return { bootID, startTime }
}

async function wait(file: string, timeout = workerTestTimeout) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (await Bun.file(file).exists()) return
    await sleep(20)
  }
  throw new Error(`Timed out waiting for file: ${file}`)
}

function spawnWorker(message: {
  mode: "claim" | "claim-exit" | "sweep"
  dbFile: string
  sessionID: string
  readyFile: string
}) {
  return spawn(process.execPath, [worker, JSON.stringify(message)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function workerExit(proc: ReturnType<typeof spawnWorker>) {
  if (proc.exitCode === 0) return Promise.resolve()
  if (proc.exitCode !== null || proc.signalCode !== null)
    return Promise.reject(new Error(`Reconcile fence worker already exited ${proc.exitCode ?? proc.signalCode}`))
  return new Promise<void>((resolve, reject) => {
    const stderr: Buffer[] = []
    proc.stderr.on("data", (data) => stderr.push(Buffer.from(data)))
    proc.on("error", reject)
    proc.on("close", (code) => {
      if (code === 0) return resolve()
      reject(new Error(`Reconcile fence worker exited ${code}: ${Buffer.concat(stderr).toString()}`))
    })
  })
}

async function stopWorker(proc: ReturnType<typeof spawnWorker>) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()))
  proc.kill()
  await closed
}

test(
  "two concurrent processes: a second process's sweep fences the first's live session and reclaims an unowned one",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranex-fence-"))
    const dbFile = join(dir, "fence.db")
    const s1 = SessionV2.ID.make("ses_fence_owned")
    const s2 = SessionV2.ID.make("ses_fence_unowned")
    const readyFile = join(dir, "claim-ready")
    const workers: ReturnType<typeof spawnWorker>[] = []
    try {
      const layer = buildSeedLayer(dbFile)
      await runInGraph(layer, seedStrandedTool(s1))
      await runInGraph(layer, seedStrandedTool(s2))

      const claimant = spawnWorker({ mode: "claim", dbFile, sessionID: s1, readyFile })
      workers.push(claimant)
      await wait(readyFile)

      const sweeper = spawnWorker({ mode: "sweep", dbFile, sessionID: s2, readyFile: join(dir, "unused") })
      workers.push(sweeper)
      await workerExit(sweeper)

      await runInGraph(
        layer,
        Effect.gen(function* () {
          const store = yield* SessionStore.Service
          expect(assistantTool(yield* store.context(s1)).state.status).toBe("running")
          expect(assistantTool(yield* store.context(s2)).state.status).toBe("error")
        }),
      )
    } finally {
      await Promise.all(workers.map((proc) => stopWorker(proc).catch(() => undefined)))
      rmSync(dir, { recursive: true, force: true })
    }
  },
  30_000,
)

test(
  "two processes: a sweep reclaims a session after its claimant exits",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranex-fence-dead-"))
    const dbFile = join(dir, "fence.db")
    const sessionID = SessionV2.ID.make("ses_fence_dead_owner")
    const readyFile = join(dir, "claim-ready")
    try {
      const layer = buildSeedLayer(dbFile)
      await runInGraph(layer, seedStrandedTool(sessionID))

      const claimant = spawnWorker({ mode: "claim-exit", dbFile, sessionID, readyFile })
      await wait(readyFile)
      await workerExit(claimant)

      const sweeper = spawnWorker({ mode: "sweep", dbFile, sessionID, readyFile: join(dir, "unused") })
      await workerExit(sweeper)

      await runInGraph(
        layer,
        Effect.gen(function* () {
          const store = yield* SessionStore.Service
          expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("error")
        }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  30_000,
)

test("isLive recognizes the current process boot and start time", async () => {
  const identity = await currentExecutionIdentity()
  expect(await ExecutionOwner.isLive(`${process.pid}:${identity.bootID}:${identity.startTime}`)).toBe(true)
})

test("isLive rejects a reused PID with a different start time", async () => {
  const identity = await currentExecutionIdentity()
  expect(await ExecutionOwner.isLive(`${process.pid}:${identity.bootID}:${identity.startTime + 1}`)).toBe(false)
})

test("isLive rejects an owner from a different boot", async () => {
  const identity = await currentExecutionIdentity()
  const differentBootID =
    identity.bootID === "00000000-0000-4000-8000-000000000000"
      ? randomUUID()
      : "00000000-0000-4000-8000-000000000000"
  expect(await ExecutionOwner.isLive(`${process.pid}:${differentBootID}:${identity.startTime}`)).toBe(false)
})

test("isLive rejects a missing PID", async () => {
  const identity = await currentExecutionIdentity()
  expect(await Bun.file("/proc/4000000/stat").exists()).toBe(false)
  expect(await ExecutionOwner.isLive(`4000000:${identity.bootID}:0`)).toBe(false)
})

test("isLive conservatively accepts an old-format owner", async () => {
  expect(await ExecutionOwner.isLive(`${process.pid}:${randomUUID()}`)).toBe(true)
})

test("runner leaves execution ownership unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranex-fence-run-"))
  const dbFile = join(dir, "fence.db")
  const sessionID = SessionV2.ID.make("ses_fence_run_claim")
  const layer = buildRunnerLayer(dbFile)
  try {
    await runInGraph(layer, seedStrandedTool(sessionID))
    await runInGraph(
      layer,
      Effect.gen(function* () {
        const runner = yield* SessionRunner.Service
        const store = yield* SessionStore.Service
        const claimed = yield* store.claimExecution(sessionID, ExecutionOwner.ownerID)
        expect(claimed).toBe(true)
        yield* runner.run({ sessionID, force: false })
        expect(yield* store.executionOwner(sessionID)).toBe(ExecutionOwner.ownerID)
        yield* store.releaseExecution(sessionID, ExecutionOwner.ownerID)
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("file-backed recovery blocks a dispatch-window marker without waking a provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranex-recovery-dispatch-"))
  const dbFile = join(dir, "recovery.db")
  const sessionID = SessionV2.ID.make("ses_recovery_dispatch_window")
  const layer = buildRunnerLayer(dbFile, recoveryClient)
  providerCalls = 0
  providerCallTimes.length = 0
  try {
    await runInGraph(
      layer,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: sessionID,
            directory: "/project",
            title: "dispatch window",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        const events = yield* EventV2.Service
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: SessionMessage.ID.make("msg_recovery_dispatch"),
          timestamp: DateTime.makeUnsafe(Date.now()),
          agent: "build",
          model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
        })
      }),
    )
    let wakes = 0
    await runInGraph(
      layer,
      Effect.gen(function* () {
        const runner = yield* SessionRunner.Service
        const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
          drain: (id, force) => runner.run({ sessionID: id, force }),
        })
        yield* SessionReconcile.recover({
          events: yield* EventV2.Service,
          store: yield* SessionStore.Service,
          sessionID,
          wake: (id, force) => Effect.sync(() => wakes++).pipe(Effect.andThen(coordinator.wake(id, force))),
        })
        const store = yield* SessionStore.Service
        expect((yield* store.blockers(sessionID)).map((blocker) => blocker.kind)).toEqual(["provider_in_flight"])
      }),
    )
    expect(wakes).toBe(0)
    expect(providerCalls).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("file-backed recovery wakes one persisted retry without republishing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranex-recovery-retry-"))
  const dbFile = join(dir, "recovery.db")
  const sessionID = SessionV2.ID.make("ses_recovery_retry_window")
  const layer = buildSeedLayer(dbFile)
  try {
    await runInGraph(
      layer,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: sessionID,
            directory: "/project",
            title: "retry window",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        const events = yield* EventV2.Service
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: SessionMessage.ID.make("msg_recovery_retry"),
          timestamp: DateTime.makeUnsafe(0),
          agent: "build",
          model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
        })
        yield* events.publish(SessionEvent.Retried, {
          sessionID,
          timestamp: DateTime.makeUnsafe(0),
          attempt: 0,
          error: { message: "unavailable", isRetryable: true },
        })
      }),
    )
    let wakes = 0
    await runInGraph(
      layer,
      Effect.gen(function* () {
        yield* SessionReconcile.recover({
          events: yield* EventV2.Service,
          store: yield* SessionStore.Service,
          sessionID,
          wake: () => Effect.sync(() => wakes++),
        })
        const { db } = yield* Database.Service
        const retried = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Retried.type, 1)))
          .all()
          .pipe(Effect.orDie)
        expect(retried).toHaveLength(1)
      }),
    )
    expect(wakes).toBe(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("file-backed committed continuation wakes the coordinator once without republishing its settled tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranex-recovery-continuation-"))
  const dbFile = join(dir, "recovery.db")
  const sessionID = SessionV2.ID.make("ses_recovery_committed_continuation")
  const layer = buildSeedLayer(dbFile)
  try {
    await runInGraph(layer, seedStrandedTool(sessionID, true))
    let wakes = 0
    let drains = 0
    await runInGraph(
      layer,
      Effect.gen(function* () {
        const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
          drain: () => Effect.sync(() => drains++),
        })
        yield* SessionReconcile.recover({
          events: yield* EventV2.Service,
          store: yield* SessionStore.Service,
          sessionID,
          wake: (id, force) => Effect.sync(() => wakes++).pipe(Effect.andThen(coordinator.wake(id, force))),
        })
        while ((yield* coordinator.active).size > 0) yield* Effect.yieldNow
        const { db } = yield* Database.Service
        const rows = yield* db.select({ type: EventTable.type }).from(EventTable).all().pipe(Effect.orDie)
        expect(rows.filter((row) => row.type === EventV2.versionedType(SessionEvent.Step.Started.type, 1))).toHaveLength(1)
        expect(rows.filter((row) => row.type === EventV2.versionedType(SessionEvent.Tool.Success.type, 1))).toHaveLength(1)
      }),
    )
    expect(wakes).toBe(1)
    expect(drains).toBe(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("recovery preserves executed false when it terminally fails a local tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranex-recovery-local-tool-"))
  const dbFile = join(dir, "recovery.db")
  const sessionID = SessionV2.ID.make("ses_recovery_local_tool")
  const layer = buildSeedLayer(dbFile)
  try {
    await runInGraph(layer, seedStrandedTool(sessionID))
    await runInGraph(
      layer,
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        yield* SessionReconcile.recover({ events, store, sessionID })
        const { db } = yield* Database.Service
        const failed = yield* db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Tool.Failed.type, 1)))
          .all()
          .pipe(Effect.orDie)
        expect(failed).toHaveLength(1)
        expect(failed[0]?.data.provider).toEqual({ executed: false })
        expect((yield* store.blockers(sessionID)).map((blocker) => blocker.kind)).toEqual(["tool_side_effect_ambiguous"])
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("concurrent recovery emits one terminal tool event and one ambiguity blocker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranex-recovery-concurrent-"))
  const dbFile = join(dir, "recovery.db")
  const sessionID = SessionV2.ID.make("ses_recovery_concurrent")
  const layer = buildSeedLayer(dbFile)
  try {
    await runInGraph(layer, seedStrandedTool(sessionID))
    await runInGraph(
      layer,
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        yield* Effect.all(
          Array.from({ length: 3 }, () => SessionReconcile.recover({ events, store, sessionID })),
          { concurrency: "unbounded" },
        )
        const { db } = yield* Database.Service
        const failed = yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Tool.Failed.type, 1)))
          .all()
          .pipe(Effect.orDie)
        expect(failed).toHaveLength(1)
        expect(yield* store.blockers(sessionID)).toHaveLength(1)
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("recovery defers its provider dispatch until the persisted retry deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranex-recovery-backoff-"))
  const dbFile = join(dir, "recovery.db")
  const sessionID = SessionV2.ID.make("ses_recovery_backoff")
  const layer = buildRunnerLayer(dbFile, recoveryClient)
  providerCalls = 0
  providerCallTimes.length = 0
  try {
    await runInGraph(
      layer,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: sessionID,
            directory: "/project",
            title: "backoff",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        const events = yield* EventV2.Service
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: SessionMessage.ID.make("msg_recovery_backoff"),
          timestamp: DateTime.makeUnsafe(0),
          agent: "build",
          model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
        })
        yield* events.publish(SessionEvent.Retried, {
          sessionID,
          timestamp: DateTime.makeUnsafe(0),
          attempt: 0,
          error: { message: "unavailable", isRetryable: true },
        })
      }),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* SessionRunner.Service
        const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
          drain: (id, force) => runner.run({ sessionID: id, force }),
        })
        yield* SessionReconcile.recover({
          events: yield* EventV2.Service,
          store: yield* SessionStore.Service,
          sessionID,
          wake: coordinator.wake,
        })
        yield* Effect.yieldNow
        expect(providerCalls).toBe(0)
        yield* TestClock.adjust("499 millis")
        expect(providerCalls).toBe(0)
        yield* TestClock.adjust("1 millis")
        while (providerCalls === 0) yield* Effect.yieldNow
        expect(providerCallTimes).toEqual([500])
      }).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(TestClock.layer())),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
