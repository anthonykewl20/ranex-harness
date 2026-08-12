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
import { ExecutionOwner } from "@ranex/core/session/execution-owner"
import { SessionMessage } from "@ranex/core/session/message"
import { SessionProjector } from "@ranex/core/session/projector"
import { SessionReconcile } from "@ranex/core/session/reconcile"
import { SessionRunner } from "@ranex/core/session/runner"
import { node } from "@ranex/core/session/runner/llm"
import { SessionRunnerModel } from "@ranex/core/session/runner/model"
import { SessionTurnLLM } from "@ranex/core/session/runner/turn-llm"
import { createLLMEventPublisher } from "@ranex/core/session/runner/publish-llm-event"
import { SessionStore } from "@ranex/core/session/store"
import { SessionTable } from "@ranex/core/session/sql"
import { SkillGuidance } from "@ranex/core/skill/guidance"
import { Snapshot } from "@ranex/core/snapshot"
import { SystemContext } from "@ranex/core/system-context"
import { SystemContextRegistry } from "@ranex/core/system-context/registry"
import { ApplicationTools } from "@ranex/core/tool/application-tools"
import { ToolRegistry } from "@ranex/core/tool/registry"
import { Effect, Layer, Schema, Scope, Stream } from "effect"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const worker = join(import.meta.dir, "fixture/reconcile-fence-worker.ts")

const client = Layer.mock(LLMClient.Service, {
  prepare: () => Effect.die("unused"),
  stream: () => Stream.empty,
  generate: () => Effect.die("unused"),
})
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
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node]),
    [[Database.node, Database.layerFromPath(dbFile)]],
  )
}

function buildRunnerLayer(dbFile: string) {
  return AppNodeBuilder.build(
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
      node,
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
}

function seedStrandedTool(sessionID: SessionV2.ID) {
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

async function wait(file: string, timeout = 3_000) {
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
