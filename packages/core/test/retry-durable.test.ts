import { expect } from "bun:test"
import { Database } from "@ranex/core/database/database"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ranex/core/effect/app-node-platform"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { EventV2 } from "@ranex/core/event"
import { EventTable } from "@ranex/core/event/sql"
import { Location } from "@ranex/core/location"
import { PermissionV2 } from "@ranex/core/permission"
import { Project } from "@ranex/core/project"
import { ProjectTable } from "@ranex/core/project/sql"
import { QuestionV2 } from "@ranex/core/question"
import { AbsolutePath } from "@ranex/core/schema"
import { SessionV2 } from "@ranex/core/session"
import { SessionEvent } from "@ranex/core/session/event"
import { SessionExecution } from "@ranex/core/session/execution"
import { Prompt } from "@ranex/core/session/prompt"
import { SessionProjector } from "@ranex/core/session/projector"
import { SessionRunCoordinator } from "@ranex/core/session/run-coordinator"
import { SessionRunner } from "@ranex/core/session/runner"
import { node as sessionRunnerNode } from "@ranex/core/session/runner/llm"
import { ModelUnavailableError, SessionRunnerModel } from "@ranex/core/session/runner/model"
import { ProviderWatchdog } from "@ranex/core/session/runner/provider-watchdog"
import { SessionTable } from "@ranex/core/session/sql"
import { SessionStore } from "@ranex/core/session/store"
import { SessionTurnLLM } from "@ranex/core/session/runner/turn-llm"
import { AgentV2 } from "@ranex/core/agent"
import { Config } from "@ranex/core/config"
import { ConfigCompaction } from "@ranex/core/config/compaction"
import { ConfigProviderFailover } from "@ranex/core/config/provider-failover"
import { SkillGuidance } from "@ranex/core/skill/guidance"
import { Snapshot } from "@ranex/core/snapshot"
import { SystemContext } from "@ranex/core/system-context"
import { SystemContextRegistry } from "@ranex/core/system-context/registry"
import { ReferenceGuidance } from "@ranex/core/reference/guidance"
import { ApplicationTools } from "@ranex/core/tool/application-tools"
import { ToolRegistry } from "@ranex/core/tool/registry"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  ProviderInternalReason,
  TransportReason,
  InvalidRequestReason,
  type LLMClientShape,
  type LLMRequest,
} from "@ranex/llm"
import { RequestExecutor } from "@ranex/llm/route"
import { route } from "@ranex/llm/protocols/openai-chat"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { asc, count, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionID = SessionV2.ID.make("ses_retry_durable")
const request = HttpClientRequest.get("https://provider.test")

const executorLayer = (calls: Ref.Ref<number>, layer = RequestExecutor.layer) =>
  layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(calls, (value) => value + 1).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 }))),
          ),
        ),
      ),
    ),
  )

const seed = Effect.gen(function* () {
  const db = (yield* Database.Service).db
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
      slug: "retry",
      directory: "/project",
      title: "retry",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

it.effect("RED: executor retry attempts reset after interruption", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const first = yield* Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      return yield* executor.execute(request)
    }).pipe(Effect.provide(executorLayer(calls)), Effect.forkChild)
    while ((yield* Ref.get(calls)) === 0) yield* Effect.yieldNow
    yield* Fiber.interrupt(first)
    const second = yield* Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      return yield* executor.execute(request).pipe(Effect.exit)
    }).pipe(Effect.provide(executorLayer(calls)), Effect.forkChild)
    yield* TestClock.adjust("30 seconds")
    yield* Fiber.join(second)
    expect(yield* Ref.get(calls)).toBe(4)
  }),
)

it.effect("decodes base-shaped retried payloads without the optional retry metadata", () =>
  Effect.sync(() => {
    const decoded = Schema.decodeUnknownSync(SessionEvent.Retried.data)({
      sessionID,
      timestamp: 0,
      attempt: 0,
      error: { message: "unavailable", statusCode: 503, isRetryable: true },
    })
    expect(decoded.error).toEqual({ message: "unavailable", statusCode: 503, isRetryable: true })
  }),
)

it.effect("projects a durable retry attempt and next-attempt delay", () =>
  Effect.gen(function* () {
    yield* seed
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.Retried, {
      sessionID,
      timestamp: DateTime.makeUnsafe(0),
      attempt: 0,
      delay_ms: 500,
      cumulative_delay_ms: 500,
      window_started_at: 0,
      remaining_delay_ms: 29_500,
      error: { message: "unavailable", statusCode: 503, isRetryable: true },
    })
    const db = (yield* Database.Service).db
    expect(
      yield* db
        .select({ attempt: SessionTable.retry_attempt, next: SessionTable.retry_next_attempt_at })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get(),
    ).toEqual({ attempt: 0, next: 500 })
  }),
)

it.effect("projects exponential retry delay without jitter", () =>
  Effect.gen(function* () {
    yield* seed
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.Retried, {
      sessionID,
      timestamp: DateTime.makeUnsafe(1_000),
      attempt: 1,
      delay_ms: 1_000,
      cumulative_delay_ms: 1_500,
      window_started_at: 0,
      remaining_delay_ms: 28_500,
      error: { message: "unavailable", statusCode: 503, isRetryable: true },
    })
    const db = (yield* Database.Service).db
    expect(
      (
        yield* db
          .select({ next: SessionTable.retry_next_attempt_at })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
      )?.next,
    ).toBe(2_000)
  }),
)

it.effect("replays base-shaped retried events without scheduling a guessed retry", () =>
  Effect.gen(function* () {
    yield* seed
    const events = yield* EventV2.Service
    const retried = {
      id: EventV2.ID.create(),
      aggregateID: sessionID,
      seq: 0,
      type: EventV2.versionedType(SessionEvent.Retried.type, 1),
      data: {
        sessionID,
        timestamp: 1_000,
        attempt: 1,
        error: { message: "unavailable", statusCode: 503, isRetryable: true },
      },
    }
    yield* events.replayAll([
      retried,
    ])
    yield* events.replayAll([retried])
    const db = (yield* Database.Service).db
    expect(
      (
        yield* db
          .select({ value: count() })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .get()
      )?.value,
    ).toBe(1)
    yield* events.remove(sessionID)
    yield* events.replayAll([retried])
    expect(
      yield* db
        .select({ attempt: SessionTable.retry_attempt, next: SessionTable.retry_next_attempt_at })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get(),
    ).toEqual({ attempt: null, next: null })
    expect(
      (
        yield* db
          .select({ value: count() })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .get()
      )?.value,
    ).toBe(1)
  }),
)

it.effect("turn executor is single-attempt", () => {
  const calls = { value: 0 }
  const layer = RequestExecutor.singleAttemptLayer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          calls.value++
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })))
        }),
      ),
    ),
  )
  return Effect.gen(function* () {
    const executor = yield* RequestExecutor.Service
    yield* executor.execute(request).pipe(Effect.exit)
    expect(calls.value).toBe(1)
  }).pipe(Effect.provide(layer))
})

it.effect("global executor retains transient-status retries", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const fiber = yield* Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      return yield* executor.execute(request).pipe(Effect.exit)
    }).pipe(Effect.provide(executorLayer(calls)), Effect.forkChild)
    yield* TestClock.adjust("30 seconds")
    yield* Fiber.join(fiber)
    expect(yield* Ref.get(calls)).toBe(3)
  }),
)

it.effect("branded turn client adapter republishes its client under a distinct tag", () => {
  const fake = LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: () => Stream.empty,
    generate: () => Effect.die("unused"),
  })
  return Effect.gen(function* () {
    const turn = yield* SessionTurnLLM.Service
    expect(turn).toBe(fake)
  }).pipe(Effect.provide(SessionTurnLLM.layerFrom(Layer.succeed(LLMClient.Service, fake))))
})

let turnCalls = 0
let turnModels: string[] = []
let turnStarted: Deferred.Deferred<void> | undefined
let turnStreams: Stream.Stream<LLMEvent, LLMError>[] | undefined
let providerFailover: ConfigProviderFailover.Info | undefined
let unavailableFailoverModels = new Set<string>()
let globalResponses: Response[] = []
let globalTransportCalls = 0

const unavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new ProviderInternalReason({ message: "Provider unavailable", status: 503 }),
  })

const overflow = () =>
  Stream.fail(
    new LLMError({
      module: "test",
      method: "stream",
      reason: new InvalidRequestReason({ message: "prompt too long", classification: "context-overflow" }),
    }),
  )

const complete = (id: string, text: string) =>
  Stream.fromIterable([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id }),
    LLMEvent.textDelta({ id, text }),
    LLMEvent.textEnd({ id }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ])

const startedThenUnavailable = () =>
  Stream.concat(
    Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "partial" })]),
    Stream.fail(unavailable()),
  )

const summaryResponse = (text = "## Objective\n- Recover overflow") =>
  new Response(
    [
      `data: ${JSON.stringify({ id: "summary", choices: [{ delta: { content: text }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: "summary", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { headers: { "content-type": "text/event-stream" } },
  )

const turnClient = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      const started = turnStarted
      turnStarted = undefined
      return Stream.unwrap(
        Effect.sync(() => {
          turnCalls++
          turnModels.push(`${request.model.provider}/${request.model.id}`)
        }).pipe(
          Effect.andThen(started ? Deferred.succeed(started, undefined) : Effect.void),
          Effect.as(turnStreams?.shift() ?? Stream.fail(unavailable())),
        ),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

const globalHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => {
      globalTransportCalls++
      return HttpClientResponse.fromWeb(
        request,
        globalResponses.shift() ?? new Response("unavailable", { status: 503 }),
      )
    }),
  ),
)
const globalClient = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(globalHttp))))
const retryModel = Model.make({
  id: "retry-model",
  provider: "test",
  route: route.with({
    endpoint: { baseURL: "https://provider.test" },
    limits: { context: 20_000, output: 1_000 },
  }),
})
const models = SessionRunnerModel.layerWith((_, override) => {
  if (override && unavailableFailoverModels.has(`${override.providerID}/${override.id}`))
    return Effect.fail(new ModelUnavailableError({ providerID: override.providerID, modelID: override.id }))
  if (!override) return Effect.succeed(retryModel)
  return Effect.succeed(Model.make({ ...retryModel, id: override.id, provider: override.providerID }))
})
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
            ...(providerFailover === undefined ? {} : { provider_failover: providerFailover }),
          }),
        }),
      ]),
  }),
)
const watchdog = Layer.succeed(
  ProviderWatchdog.Service,
  ProviderWatchdog.Service.of({ settings: () => Effect.succeed({ idle: undefined, absolute: undefined }) }),
)
const runnerLayer = AppNodeBuilder.build(sessionRunnerNode, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, globalClient],
  [SessionTurnLLM.node, SessionTurnLLM.layerFrom(turnClient)],
  [SessionRunnerModel.node, models],
  [ProviderWatchdog.node, watchdog],
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
      drain: (id, force) => runner.run({ sessionID: id, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const drivingIt = testEffect(
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
      [LayerNodePlatform.llmClient, globalClient],
      [SessionTurnLLM.node, SessionTurnLLM.layerFrom(turnClient)],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [ProviderWatchdog.node, watchdog],
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

const insertDrivingSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "durable retry",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    turnCalls = 0
    turnModels = []
    turnStarted = undefined
    turnStreams = undefined
    providerFailover = undefined
    unavailableFailoverModels = new Set()
    globalResponses = []
    globalTransportCalls = 0
  })

const retriedAttempts = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const rows = yield* db
      .select({ data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Retried.type, 1)))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    return rows.filter((row) => row.data.sessionID === id).map((row) => row.data.attempt)
  })

const durableTypes = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie, Effect.map((rows) => rows.map((row) => row.type)))
  })

drivingIt.effect("GREEN: fresh drain honors persisted retry delay and resumes remaining attempts", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_driving_green")
    yield* insertDrivingSession(id)
    const session = yield* SessionV2.Service
    const sessionExecution = yield* SessionExecution.Service
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db
    yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Retry durably" }), resume: false })
    const firstStarted = yield* Deferred.make<void>()
    turnStarted = firstStarted
    const firstRetried = yield* events.subscribe(SessionEvent.Retried).pipe(Stream.runHead, Effect.forkScoped)
    yield* Effect.yieldNow
    const firstDrain = yield* sessionExecution.resume(id).pipe(Effect.forkChild)
    yield* Deferred.await(firstStarted)
    expect(
      (yield* Fiber.join(firstRetried)).pipe(
        Option.map((event) => event.data),
        Option.getOrUndefined,
      ),
    ).toMatchObject({
      attempt: 0,
      retry_class: "server",
      delay_ms: 500,
      cumulative_delay_ms: 500,
      remaining_delay_ms: 29_500,
    })
    expect(turnCalls).toBe(1)
    expect(
      yield* db
        .select({
          attempt: SessionTable.retry_attempt,
          next_attempt_at: SessionTable.retry_next_attempt_at,
          cumulative_delay_ms: SessionTable.retry_cumulative_delay_ms,
          window_started_at: SessionTable.retry_window_started_at,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, id))
        .get()
        .pipe(Effect.orDie),
    ).toEqual({ attempt: 0, next_attempt_at: 500, cumulative_delay_ms: 500, window_started_at: 0 })
    yield* sessionExecution.interrupt(id)
    const firstExit = yield* Fiber.await(firstDrain)
    expect(Exit.isFailure(firstExit) && Cause.hasInterrupts(firstExit.cause)).toBeTrue()

    const secondStarted = yield* Deferred.make<void>()
    turnStarted = secondStarted
    const freshDrain = yield* sessionExecution.resume(id).pipe(Effect.exit, Effect.forkChild)
    yield* Effect.yieldNow
    expect(turnCalls).toBe(1)
    yield* TestClock.adjust("499 millis")
    expect(turnCalls).toBe(1)
    yield* TestClock.adjust("1 millis")
    yield* Deferred.await(secondStarted)
    expect(turnCalls).toBe(2)
    while ((yield* retriedAttempts(id)).length < 2) yield* Effect.yieldNow
    expect(yield* retriedAttempts(id)).toEqual([0, 1])
    yield* TestClock.adjust("1 second")
    const exit = yield* Fiber.join(freshDrain)
    expect(Exit.isFailure(exit)).toBeTrue()
    expect(turnCalls).toBe(3)
    expect(yield* retriedAttempts(id)).toEqual([0, 1])
    expect(
      yield* db
        .select({ attempt: SessionTable.retry_attempt, next_attempt_at: SessionTable.retry_next_attempt_at })
        .from(SessionTable)
        .where(eq(SessionTable.id, id))
        .get()
        .pipe(Effect.orDie),
    ).toEqual({ attempt: null, next_attempt_at: null })
  }),
)

drivingIt.effect("clears an elapsed persisted retry without dispatching a provider turn", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_elapsed_restart")
    yield* insertDrivingSession(id)
    const events = yield* EventV2.Service
    const sessionExecution = yield* SessionExecution.Service
    const db = (yield* Database.Service).db
    yield* events.publish(SessionEvent.Retried, {
      sessionID: id,
      timestamp: DateTime.makeUnsafe(0),
      attempt: 0,
      retry_class: "server",
      delay_ms: 500,
      cumulative_delay_ms: 500,
      window_started_at: 0,
      remaining_delay_ms: 29_500,
      error: { message: "unavailable", statusCode: 503, isRetryable: true },
    })
    yield* TestClock.adjust("2 minutes")

    expect(Exit.isSuccess(yield* sessionExecution.resume(id).pipe(Effect.exit))).toBeTrue()
    expect(turnCalls).toBe(0)
    expect(
      yield* db
        .select({
          attempt: SessionTable.retry_attempt,
          next_attempt_at: SessionTable.retry_next_attempt_at,
          cumulative_delay_ms: SessionTable.retry_cumulative_delay_ms,
          window_started_at: SessionTable.retry_window_started_at,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, id))
        .get()
        .pipe(Effect.orDie),
    ).toEqual({ attempt: null, next_attempt_at: null, cumulative_delay_ms: null, window_started_at: null })
  }),
)

drivingIt.effect("restart preserves the cumulative retry delay ceiling", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_cumulative_restart")
    yield* insertDrivingSession(id)
    const events = yield* EventV2.Service
    const sessionExecution = yield* SessionExecution.Service
    turnStreams = [Stream.fail(unavailable())]
    yield* events.publish(SessionEvent.Retried, {
      sessionID: id,
      timestamp: DateTime.makeUnsafe(0),
      attempt: 0,
      retry_class: "server",
      delay_ms: 500,
      cumulative_delay_ms: 29_500,
      window_started_at: 0,
      remaining_delay_ms: 500,
      error: { message: "unavailable", statusCode: 503, isRetryable: true },
    })
    const drain = yield* sessionExecution.resume(id).pipe(Effect.exit, Effect.forkChild)
    yield* TestClock.adjust("500 millis")
    expect(Exit.isFailure(yield* Fiber.join(drain))).toBeTrue()
    expect(turnCalls).toBe(1)
    expect(yield* retriedAttempts(id)).toEqual([0])
  }),
)

drivingIt.effect("retries retryable in-band provider errors durably", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_in_band_provider_error")
    yield* insertDrivingSession(id)
    const session = yield* SessionV2.Service
    const sessionExecution = yield* SessionExecution.Service
    turnStreams = [
      Stream.fromIterable([LLMEvent.providerError({ message: "Bedrock throttled", retryable: true })]),
      complete("recovered", "Recovered"),
    ]
    yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Retry in-band failure" }), resume: false })
    const drain = yield* sessionExecution.resume(id).pipe(Effect.exit, Effect.forkChild)
    while ((yield* retriedAttempts(id)).length < 1) yield* Effect.yieldNow
    expect(turnCalls).toBe(1)
    yield* TestClock.adjust("500 millis")
    expect(Exit.isSuccess(yield* Fiber.join(drain))).toBeTrue()
    expect(turnCalls).toBe(2)
    expect(yield* retriedAttempts(id)).toEqual([0])
    expect(yield* session.context(id)).toMatchObject([
      { type: "user", text: "Retry in-band failure" },
      { type: "assistant", content: [{ type: "text", text: "Recovered" }] },
    ])
  }),
)

drivingIt.effect("keeps non-retryable in-band provider errors terminal", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_non_retryable_in_band_provider_error")
    yield* insertDrivingSession(id)
    const session = yield* SessionV2.Service
    turnStreams = [Stream.fromIterable([LLMEvent.providerError({ message: "Invalid provider response" })])]
    yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Do not retry" }), resume: false })
    yield* session.resume(id)
    expect(turnCalls).toBe(1)
    expect(yield* retriedAttempts(id)).toEqual([])
    expect(yield* session.context(id)).toMatchObject([
      { type: "user", text: "Do not retry" },
      { type: "assistant", finish: "error", error: { message: "Invalid provider response" } },
    ])
  }),
)

drivingIt.effect("does not retry after the assistant has started", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_after_assistant_started")
    yield* insertDrivingSession(id)
    const session = yield* SessionV2.Service
    const sessionExecution = yield* SessionExecution.Service
    turnStreams = [startedThenUnavailable()]
    yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Do not retry partial output" }), resume: false })
    yield* sessionExecution.resume(id).pipe(Effect.exit)
    expect(turnCalls).toBe(1)
    expect(yield* retriedAttempts(id)).toEqual([])
  }),
)

drivingIt.effect("does not retry an interrupted provider turn", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_interrupted_provider_turn")
    yield* insertDrivingSession(id)
    const session = yield* SessionV2.Service
    const sessionExecution = yield* SessionExecution.Service
    turnStreams = [Stream.fromEffect(Effect.interrupt)]
    yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Do not retry interruption" }), resume: false })
    const exit = yield* sessionExecution.resume(id).pipe(Effect.exit)
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBeTrue()
    expect(turnCalls).toBe(1)
    expect(yield* retriedAttempts(id)).toEqual([])
  }),
)

drivingIt.effect("OVERFLOW: retryable failure after overflow compaction remains typed", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_driving_overflow")
    yield* insertDrivingSession(id)
    const session = yield* SessionV2.Service
    const sessionExecution = yield* SessionExecution.Service
    turnStreams = [overflow(), Stream.fail(unavailable()), Stream.fail(unavailable()), Stream.fail(unavailable())]
    globalResponses = [summaryResponse()]
    yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Earlier question ".repeat(700) }), resume: false })
    const drain = yield* sessionExecution.resume(id).pipe(Effect.exit, Effect.forkChild)
    while (turnCalls < 2) yield* Effect.yieldNow
    yield* TestClock.adjust("500 millis")
    while (turnCalls < 3) yield* Effect.yieldNow
    yield* TestClock.adjust("1 second")
    const exit = yield* Fiber.join(drain)
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBeTrue()
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBeFalse()
    expect(turnCalls + globalTransportCalls).toBe(5)
    expect(yield* retriedAttempts(id)).toEqual([0, 1])
  }),
)

drivingIt.effect("compaction keeps global executor transient-status retries", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_driving_compaction")
    yield* insertDrivingSession(id)
    const session = yield* SessionV2.Service
    const sessionExecution = yield* SessionExecution.Service
    turnStreams = [overflow(), complete("final", "Recovered")]
    globalResponses = [
      new Response("unavailable", { status: 503 }),
      new Response("unavailable", { status: 503 }),
      summaryResponse(),
    ]
    yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Earlier question ".repeat(700) }), resume: false })
    const drain = yield* sessionExecution.resume(id).pipe(Effect.exit, Effect.forkChild)
    yield* TestClock.adjust("30 seconds")
    const exit = yield* Fiber.join(drain)
    expect(Exit.isSuccess(exit)).toBeTrue()
    expect(globalTransportCalls).toBe(3)
    expect(turnCalls).toBe(2)
  }),
)

drivingIt.effect("mixed 503 then overflow preserves the retry attempt through compaction", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_driving_mixed")
    yield* insertDrivingSession(id)
    const session = yield* SessionV2.Service
    const sessionExecution = yield* SessionExecution.Service
    turnStreams = [Stream.fail(unavailable()), overflow(), Stream.fail(unavailable()), Stream.fail(unavailable())]
    globalResponses = [summaryResponse()]
    yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Earlier question ".repeat(700) }), resume: false })
    const drain = yield* sessionExecution.resume(id).pipe(Effect.exit, Effect.forkChild)
    while (turnCalls < 1) yield* Effect.yieldNow
    yield* TestClock.adjust("500 millis")
    while (turnCalls < 3) yield* Effect.yieldNow
    yield* TestClock.adjust("1 second")
    const exit = yield* Fiber.join(drain)
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBeTrue()
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBeFalse()
    expect(yield* retriedAttempts(id)).toEqual([0, 1])
    expect(turnCalls).toBe(4)
    expect(globalTransportCalls).toBe(1)
  }),
)

drivingIt.effect("fails over once retries are exhausted before the fallback provider turn", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_failover")
    yield* insertDrivingSession(id)
    providerFailover = new ConfigProviderFailover.Info({ chain: ["backup/fallback"] })
    turnStreams = [Stream.fail(unavailable()), Stream.fail(unavailable()), Stream.fail(unavailable()), complete("ok", "Recovered")]
    const session = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service
    yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Fail over" }), resume: false })
    const drain = yield* execution.resume(id).pipe(Effect.exit, Effect.forkChild)
    while ((yield* retriedAttempts(id)).length < 1) yield* Effect.yieldNow
    yield* TestClock.adjust("500 millis")
    while ((yield* retriedAttempts(id)).length < 2) yield* Effect.yieldNow
    yield* TestClock.adjust("1 second")
    expect(Exit.isSuccess(yield* Fiber.join(drain))).toBeTrue()
    expect(turnModels).toEqual(["test/retry-model", "test/retry-model", "test/retry-model", "backup/fallback"])
    const types = yield* durableTypes(id)
    expect(types.indexOf("session.next.model.failed_over.1")).toBeLessThan(types.lastIndexOf("session.next.step.started.1"))
    expect(types.filter((type) => type === "session.next.context.updated.1")).toHaveLength(1)
    expect((yield* session.context(id)).at(-1)).toMatchObject({
      type: "assistant",
      content: [{ type: "text", text: "Recovered" }],
    })
  }),
)

drivingIt.effect("skips unavailable failover entries and uses the next model", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_failover_skip")
    yield* insertDrivingSession(id)
    providerFailover = new ConfigProviderFailover.Info({ chain: ["backup/missing", "backup/available"] })
    unavailableFailoverModels = new Set(["backup/missing"])
    turnStreams = [Stream.fail(unavailable()), Stream.fail(unavailable()), Stream.fail(unavailable()), complete("ok", "Recovered")]
    const session = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service
    yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Skip unavailable" }), resume: false })
    const drain = yield* execution.resume(id).pipe(Effect.exit, Effect.forkChild)
    while ((yield* retriedAttempts(id)).length < 1) yield* Effect.yieldNow
    yield* TestClock.adjust("500 millis")
    while ((yield* retriedAttempts(id)).length < 2) yield* Effect.yieldNow
    yield* TestClock.adjust("1 second")
    expect(Exit.isSuccess(yield* Fiber.join(drain))).toBeTrue()
    expect(turnModels.at(-1)).toBe("backup/available")
  }),
)

drivingIt.effect("uses each failover entry at most once in a drain", () =>
  Effect.gen(function* () {
    const id = SessionV2.ID.make("ses_retry_failover_once")
    yield* insertDrivingSession(id)
    providerFailover = new ConfigProviderFailover.Info({ chain: ["backup/first", "backup/second"] })
    turnStreams = [
      Stream.fail(unavailable()),
      Stream.fail(unavailable()),
      Stream.fail(unavailable()),
      Stream.fail(unavailable()),
      Stream.fail(unavailable()),
      Stream.fail(unavailable()),
      complete("ok", "Recovered"),
    ]
    const session = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service
    yield* session.prompt({ sessionID: id, prompt: Prompt.make({ text: "Fail over once" }), resume: false })
    const drain = yield* execution.resume(id).pipe(Effect.exit, Effect.forkChild)
    for (const [attempts, delay] of [
      [1, "500 millis"],
      [2, "1 second"],
      [3, "500 millis"],
      [4, "1 second"],
    ] as const) {
      while ((yield* retriedAttempts(id)).length < attempts) yield* Effect.yieldNow
      yield* TestClock.adjust(delay)
    }
    expect(Exit.isSuccess(yield* Fiber.join(drain))).toBeTrue()
    expect(turnModels).toEqual([
      "test/retry-model",
      "test/retry-model",
      "test/retry-model",
      "backup/first",
      "backup/first",
      "backup/first",
      "backup/second",
    ])
  }),
)

drivingIt.effect("does not fail over after assistant output or interruption", () =>
  Effect.gen(function* () {
    const outputID = SessionV2.ID.make("ses_retry_failover_output")
    yield* insertDrivingSession(outputID)
    providerFailover = new ConfigProviderFailover.Info({ chain: ["backup/fallback"] })
    turnStreams = [startedThenUnavailable()]
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID: outputID, prompt: Prompt.make({ text: "Keep partial" }), resume: false })
    yield* session.resume(outputID).pipe(Effect.exit)
    expect(turnCalls).toBe(1)
    expect((yield* durableTypes(outputID)).includes("session.next.model.failed_over.1")).toBeFalse()

    const interruptedID = SessionV2.ID.make("ses_retry_failover_interrupt")
    yield* insertDrivingSession(interruptedID)
    providerFailover = new ConfigProviderFailover.Info({ chain: ["backup/fallback"] })
    turnStreams = [Stream.fromEffect(Effect.interrupt)]
    yield* session.prompt({ sessionID: interruptedID, prompt: Prompt.make({ text: "Interrupt" }), resume: false })
    yield* session.resume(interruptedID).pipe(Effect.exit)
    expect(turnCalls).toBe(1)
    expect((yield* durableTypes(interruptedID)).includes("session.next.model.failed_over.1")).toBeFalse()
  }),
)

drivingIt.effect("uses watchdog failover only when explicitly enabled", () =>
  Effect.gen(function* () {
    const error = () =>
      Stream.fail(
        new LLMError({
          module: "test",
          method: "stream",
          reason: new TransportReason({ message: "watchdog", kind: "watchdog-idle" }),
        }),
      )
    const disabledID = SessionV2.ID.make("ses_retry_failover_watchdog_disabled")
    yield* insertDrivingSession(disabledID)
    providerFailover = new ConfigProviderFailover.Info({ chain: ["backup/fallback"] })
    turnStreams = [error(), error(), error()]
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID: disabledID, prompt: Prompt.make({ text: "No watchdog fallback" }), resume: false })
    const disabled = yield* session.resume(disabledID).pipe(Effect.exit, Effect.forkChild)
    while ((yield* retriedAttempts(disabledID)).length < 1) yield* Effect.yieldNow
    yield* TestClock.adjust("500 millis")
    while ((yield* retriedAttempts(disabledID)).length < 2) yield* Effect.yieldNow
    yield* TestClock.adjust("1 second")
    expect(Exit.isFailure(yield* Fiber.join(disabled))).toBeTrue()
    expect((yield* durableTypes(disabledID)).includes("session.next.model.failed_over.1")).toBeFalse()

    const enabledID = SessionV2.ID.make("ses_retry_failover_watchdog_enabled")
    yield* insertDrivingSession(enabledID)
    providerFailover = new ConfigProviderFailover.Info({ chain: ["backup/fallback"], on_watchdog: true })
    turnStreams = [error(), complete("ok", "Recovered")]
    yield* session.prompt({ sessionID: enabledID, prompt: Prompt.make({ text: "Watchdog fallback" }), resume: false })
    const enabled = yield* session.resume(enabledID).pipe(Effect.exit, Effect.forkChild)
    while (turnCalls < 2) yield* Effect.yieldNow
    expect(Exit.isSuccess(yield* Fiber.join(enabled))).toBeTrue()
    expect(turnModels).toEqual(["test/retry-model", "backup/fallback"])
  }),
)
