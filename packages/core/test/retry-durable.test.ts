import { expect } from "bun:test"
import { Database } from "@ranex/core/database/database"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { EventV2 } from "@ranex/core/event"
import { EventTable } from "@ranex/core/event/sql"
import { Project } from "@ranex/core/project"
import { ProjectTable } from "@ranex/core/project/sql"
import { AbsolutePath } from "@ranex/core/schema"
import { SessionV2 } from "@ranex/core/session"
import { SessionEvent } from "@ranex/core/session/event"
import { SessionProjector } from "@ranex/core/session/projector"
import { SessionTable } from "@ranex/core/session/sql"
import { SessionTurnLLM } from "@ranex/core/session/runner/turn-llm"
import { LLMClient, RequestExecutor } from "@ranex/llm/route"
import { DateTime, Effect, Fiber, Layer, Ref, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { count, eq } from "drizzle-orm"
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

it.effect("projects a durable retry attempt and next-attempt delay", () =>
  Effect.gen(function* () {
    yield* seed
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.Retried, {
      sessionID,
      timestamp: DateTime.makeUnsafe(0),
      attempt: 0,
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

it.effect("replaying one retried event is idempotent in the durable log", () =>
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
    ).toEqual({ attempt: 1, next: 2_000 })
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
