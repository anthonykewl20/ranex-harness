import { expect } from "bun:test"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  ProviderInternalReason,
  InvalidRequestReason,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { node as sessionRunnerNode } from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import { asc, eq } from "drizzle-orm"
import { RequestExecutor } from "../../llm/src/route"
import { testEffect } from "./lib/effect"

let executorCalls = 0
const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => {
      executorCalls++
      return HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 }))
    }),
  ),
)
const baselineIt = testEffect(RequestExecutor.layer.pipe(Layer.provide(http)))

baselineIt.effect("unsafe baseline resets executor retry attempts after teardown", () =>
  Effect.gen(function* () {
    executorCalls = 0
    const executor = yield* RequestExecutor.Service
    const request = HttpClientRequest.get("https://example.test/retry")

    const tornDown = yield* executor.execute(request).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    expect(executorCalls).toBe(1)
    yield* Fiber.interrupt(tornDown)

    const fresh = yield* executor.execute(request).pipe(Effect.forkChild)
    yield* TestClock.adjust("30 seconds")
    expect((yield* Fiber.await(fresh))._tag).toBe("Failure")
    expect(executorCalls).toBe(4)
  }),
)

let providerCalls = 0
let providerStarted: Deferred.Deferred<void> | undefined
let providerStreams: Stream.Stream<LLMEvent, LLMError>[] | undefined
const unavailable = () =>
  new LLMError({
    module: "prototype",
    method: "stream",
    reason: new ProviderInternalReason({ message: "Provider unavailable", status: 503 }),
  })
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((_request: LLMRequest) => {
      const started = providerStarted
      providerStarted = undefined
      return Stream.unwrap(
        Effect.sync(() => providerCalls++).pipe(
          Effect.andThen(started ? Deferred.succeed(started, undefined) : Effect.void),
          Effect.as(providerStreams?.shift() ?? Stream.fail(unavailable())),
        ),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({
  id: "retry-model",
  provider: "prototype",
  route: route.with({ limits: { context: 20_000, output: 1_000 } }),
})
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const permission = Layer.mock(PermissionV2.Service, {
  assert: () => Effect.die("unused"),
  ask: () => Effect.die("unused"),
  reply: () => Effect.die("unused"),
  get: () => Effect.die("unused"),
  forSession: () => Effect.die("unused"),
  list: () => Effect.die("unused"),
})
const systemContext = Layer.mock(SystemContextRegistry.Service, { load: () => Effect.succeed(SystemContext.empty) })
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
const runnerLayer = AppNodeBuilder.build(sessionRunnerNode, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [Config.node, config],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const runner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => runner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const greenIt = testEffect(
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
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      sessionRunnerNode,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_retry_prototype")

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "retry prototype",
        version: "prototype",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

greenIt.effect("fresh drain honors persisted retry delay and resumes remaining attempts", () =>
  Effect.gen(function* () {
    yield* insertSession(sessionID)
    const session = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    providerCalls = 0
    providerStreams = undefined
    const firstStarted = yield* Deferred.make<void>()
    providerStarted = firstStarted
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Retry durably" }), resume: false })

    const firstRetry = yield* events.subscribe(SessionEvent.Retried).pipe(Stream.runHead, Effect.forkScoped)
    yield* Effect.yieldNow
    const firstDrain = yield* execution.resume(sessionID).pipe(Effect.forkChild)
    const firstOutcome = yield* Effect.race(
      Deferred.await(firstStarted).pipe(Effect.as("started" as const)),
      Fiber.await(firstDrain),
    )
    expect(firstOutcome).toBe("started")
    const firstEvent = yield* Fiber.join(firstRetry)
    expect(firstEvent._tag).toBe("Some")
    if (firstEvent._tag === "Some") {
      expect(firstEvent.value.data.attempt).toBe(0)
      expect(firstEvent.value.data.error).toMatchObject({ statusCode: 503, isRetryable: true })
    }
    expect(providerCalls).toBe(1)

    const persisted = yield* database.db
      .select({ attempt: SessionTable.retry_attempt, nextAttemptAt: SessionTable.retry_next_attempt_at })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    expect(persisted?.attempt).toBe(0)
    expect(persisted?.nextAttemptAt).toBe(500)
    yield* execution.interrupt(sessionID)
    expect((yield* Fiber.await(firstDrain))._tag).toBe("Failure")

    const secondStarted = yield* Deferred.make<void>()
    providerStarted = secondStarted
    const secondRetry = yield* events.subscribe(SessionEvent.Retried).pipe(Stream.runHead, Effect.forkScoped)
    yield* Effect.yieldNow
    const freshDrain = yield* execution.resume(sessionID).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    expect(providerCalls).toBe(1)
    yield* TestClock.adjust("499 millis")
    expect(providerCalls).toBe(1)
    yield* TestClock.adjust("1 millis")
    yield* Deferred.await(secondStarted)
    const secondEvent = yield* Fiber.join(secondRetry)
    expect(secondEvent._tag).toBe("Some")
    if (secondEvent._tag === "Some") expect(secondEvent.value.data.attempt).toBe(1)
    expect(providerCalls).toBe(2)

    const thirdStarted = yield* Deferred.make<void>()
    providerStarted = thirdStarted
    yield* TestClock.adjust("1 second")
    yield* Deferred.await(thirdStarted)
    expect((yield* Fiber.await(freshDrain))._tag).toBe("Failure")
    expect(providerCalls).toBe(3)
    const retried = yield* database.db
      .select({ data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Retried.type, 1)))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    expect(retried.map((event) => event.data.attempt)).toEqual([0, 1])
    expect(retried[0]?.data.error).toMatchObject({ statusCode: 503, isRetryable: true })
    expect(
      yield* database.db
        .select({ attempt: SessionTable.retry_attempt, nextAttemptAt: SessionTable.retry_next_attempt_at })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie),
    ).toEqual({ attempt: null, nextAttemptAt: null })
  }),
)

greenIt.effect("overflow recovery retries and terminates with a typed provider failure", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_overflow_prototype")
    yield* insertSession(id)
    const session = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service
    const events = yield* EventV2.Service
    providerCalls = 0
    providerStreams = [
      Stream.fail(
        new LLMError({
          module: "prototype",
          method: "stream",
          reason: new InvalidRequestReason({ message: "prompt too long", classification: "context-overflow" }),
        }),
      ),
      Stream.fromIterable([
        LLMEvent.textStart({ id: "overflow-summary" }),
        LLMEvent.textDelta({ id: "overflow-summary", text: "## Objective\n- Recover overflow" }),
        LLMEvent.textEnd({ id: "overflow-summary" }),
        LLMEvent.finish({ reason: "stop" }),
      ]),
      Stream.fail(unavailable()),
      Stream.fail(unavailable()),
      Stream.fail(unavailable()),
    ]
    yield* session.prompt({
      sessionID: id,
      prompt: Prompt.make({ text: "Earlier question ".repeat(700) }),
      resume: false,
    })

    const retried = yield* events.subscribe(SessionEvent.Retried).pipe(Stream.runHead, Effect.forkScoped)
    yield* Effect.yieldNow
    const drain = yield* execution.resume(id).pipe(Effect.exit, Effect.forkChild)
    yield* TestClock.adjust("500 millis")
    const retryEvent = yield* Fiber.join(retried)
    expect(retryEvent._tag).toBe("Some")
    if (retryEvent._tag === "Some") {
      expect(retryEvent.value.data.attempt).toBe(0)
      expect(retryEvent.value.data.error).toMatchObject({ statusCode: 503, isRetryable: true })
    }
    yield* TestClock.adjust("1 second")

    const outcome = yield* Fiber.join(drain)
    expect(Exit.isFailure(outcome) && Cause.hasFails(outcome.cause)).toBeTrue()
    expect(Exit.isFailure(outcome) && Cause.hasDies(outcome.cause)).toBeFalse()
    if (Exit.isFailure(outcome))
      expect(Option.getOrUndefined(Cause.findErrorOption(outcome.cause))).toBeInstanceOf(LLMError)
    expect(providerCalls).toBe(5)
    providerStreams = undefined
  }),
)

greenIt.effect("replaying the same retried projection is idempotent", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_projection_prototype")
    yield* insertSession(id)
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    const published = yield* events.publish(SessionEvent.Retried, {
      sessionID: id,
      timestamp: DateTime.makeUnsafe(1_000),
      attempt: 1,
      error: { message: "unavailable", statusCode: 503, isRetryable: true },
    })
    const stored = yield* database.db
      .select()
      .from(EventTable)
      .where(eq(EventTable.id, published.id))
      .get()
      .pipe(Effect.orDie)
    if (!stored) return yield* Effect.die("Retried event was not stored")
    const serialized = {
      id: stored.id,
      aggregateID: stored.aggregate_id,
      seq: stored.seq,
      type: stored.type,
      data: stored.data,
    }
    yield* events.remove(id)
    yield* events.replayAll([serialized])
    const firstState = yield* database.db
      .select({ attempt: SessionTable.retry_attempt, nextAttemptAt: SessionTable.retry_next_attempt_at })
      .from(SessionTable)
      .where(eq(SessionTable.id, id))
      .get()
      .pipe(Effect.orDie)
    yield* events.replayAll([serialized])
    expect(
      yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all().pipe(Effect.orDie),
    ).toHaveLength(1)
    expect(
      yield* database.db
        .select({ attempt: SessionTable.retry_attempt, nextAttemptAt: SessionTable.retry_next_attempt_at })
        .from(SessionTable)
        .where(eq(SessionTable.id, id))
        .get()
        .pipe(Effect.orDie),
    ).toEqual(firstState)
    yield* events.remove(id)
    yield* events.replayAll([serialized])

    const state = yield* database.db
      .select({ attempt: SessionTable.retry_attempt, nextAttemptAt: SessionTable.retry_next_attempt_at })
      .from(SessionTable)
      .where(eq(SessionTable.id, id))
      .get()
      .pipe(Effect.orDie)
    expect(state).toEqual({ attempt: 1, nextAttemptAt: 2_000 })
    expect(
      yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all().pipe(Effect.orDie),
    ).toHaveLength(1)
  }),
)
