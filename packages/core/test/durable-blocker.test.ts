import { describe, expect, test } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { sql } from "drizzle-orm"
import { location } from "./fixture/location"

const sessionID = SessionV2.ID.make("ses_durable_blocker")
const locationCurrent = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const question: QuestionV2.Info = {
  question: "Which option?",
  header: "Option",
  options: [{ label: "One", description: "First option" }],
}

function graphForPermission(db: Database.Interface["db"], events?: EventV2.Interface) {
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [
      [Database.node, Layer.succeed(Database.Service, { db })],
      [Location.node, locationCurrent],
      ...(events ? ([[EventV2.node, Layer.succeed(EventV2.Service, events)]] as const) : []),
    ],
  )
}

function graphForQuestion(db: Database.Interface["db"], events?: EventV2.Interface) {
  return AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, QuestionV2.node]), [
    [Database.node, Layer.succeed(Database.Service, { db })],
    ...(events ? ([[EventV2.node, Layer.succeed(EventV2.Service, events)]] as const) : []),
  ])
}

function eventGraph(db: Database.Interface["db"]) {
  return AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]), [
    [Database.node, Layer.succeed(Database.Service, { db })],
  ])
}

function setup(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    yield* db.run(sql`CREATE TABLE IF NOT EXISTS permission_request (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      data text NOT NULL,
      agent text,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    )`)
    yield* db.run(sql`CREATE TABLE IF NOT EXISTS question_request (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      data text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    )`)
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
        slug: "durable-blocker",
        directory: "/project",
        title: "durable blocker",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
}

function requestCount(db: Database.Interface["db"], table: "permission_request" | "question_request", requestID: string) {
  const query =
    table === "permission_request"
      ? sql`SELECT count(*) as c FROM permission_request WHERE id = ${requestID}`
      : sql`SELECT count(*) as c FROM question_request WHERE id = ${requestID}`
  return db
    .get<{ c: number }>(query)
    .pipe(Effect.map((row) => row?.c ?? 0))
}

function withDatabase<E>(effect: (db: Database.Interface["db"]) => Effect.Effect<void, E, Scope.Scope>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.fresh(AppNodeBuilder.build(Database.node)))
      const db = Context.get(context, Database.Service).db
      yield* setup(db)
      yield* effect(db)
    }),
  )
}

function waitForPermission(context: Context.Context<PermissionV2.Service | EventV2.Service | AgentV2.Service>) {
  return Effect.gen(function* () {
    const service = Context.get(context, PermissionV2.Service)
    const events = Context.get(context, EventV2.Service)
    const agents = Context.get(context, AgentV2.Service)
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = []
      }),
    )
    const asked = yield* Deferred.make<PermissionV2.Request>()
    yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    const fiber = yield* service
      .assert({ sessionID, action: "read", resources: ["src/index.ts"] })
      .pipe(Effect.forkScoped)
    return { fiber, request: yield* Deferred.await(asked) }
  })
}

function waitForQuestion(context: Context.Context<QuestionV2.Service | EventV2.Service>) {
  return Effect.gen(function* () {
    const service = Context.get(context, QuestionV2.Service)
    const events = Context.get(context, EventV2.Service)
    const asked = yield* Deferred.make<QuestionV2.Request>()
    yield* events.listen((event) =>
      event.type === QuestionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as QuestionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    const fiber = yield* service.ask({ sessionID, questions: [question] }).pipe(Effect.forkScoped)
    return { fiber, request: yield* Deferred.await(asked) }
  })
}

describe("durable blockers", () => {
  test("permission remains replyable exactly once across teardown", () =>
    Effect.runPromise(
      withDatabase((db) =>
        Effect.gen(function* () {
          const firstScope = yield* Scope.make()
          const firstContext = yield* Layer.buildWithScope(Layer.fresh(graphForPermission(db)), firstScope)
          const { fiber, request } = yield* waitForPermission(firstContext)
          yield* Scope.close(firstScope, Exit.void)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit))
            expect(
              exit.cause.reasons.some(
                (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
              ),
            ).toBe(true)

          const secondScope = yield* Scope.make()
          const eventContext = yield* Layer.buildWithScope(Layer.fresh(eventGraph(db)), secondScope)
          const events = Context.get(eventContext, EventV2.Service)
          let republished = 0
          yield* events.listen((event) =>
            Effect.sync(() => {
              if (
                event.type === PermissionV2.Event.Asked.type &&
                (event.data as PermissionV2.Request).id === request.id
              )
                republished++
            }),
          )
          const secondContext = yield* Layer.buildWithScope(
            Layer.fresh(graphForPermission(db, events)),
            secondScope,
          )
          const service = Context.get(secondContext, PermissionV2.Service)
          expect((yield* service.list()).some((item) => item.id === request.id)).toBe(true)
          expect((yield* service.forSession(sessionID)).some((item) => item.id === request.id)).toBe(true)
          expect(yield* service.get(request.id)).toBeDefined()
          // Asked is non-durable, so the in-process listener installed before
          // rehydration is the no-rerun authority: rehydration must not publish.
          expect(republished).toBe(0)
          yield* service.reply({ requestID: request.id, reply: "once" })
          expect(yield* requestCount(db, "permission_request", request.id)).toBe(0)
          expect(yield* service.reply({ requestID: request.id, reply: "once" }).pipe(Effect.flip)).toEqual(
            new PermissionV2.NotFoundError({ requestID: request.id }),
          )
          yield* Scope.close(secondScope, Exit.void)
        }),
      ),
    ),
  )

  test("permission rejection removes a rehydrated blocker", () =>
    Effect.runPromise(
      withDatabase((db) =>
        Effect.gen(function* () {
          const firstScope = yield* Scope.make()
          const firstContext = yield* Layer.buildWithScope(Layer.fresh(graphForPermission(db)), firstScope)
          const { fiber, request } = yield* waitForPermission(firstContext)
          yield* Scope.close(firstScope, Exit.void)
          yield* Fiber.await(fiber)
          const secondScope = yield* Scope.make()
          const secondContext = yield* Layer.buildWithScope(Layer.fresh(graphForPermission(db)), secondScope)
          const service = Context.get(secondContext, PermissionV2.Service)
          yield* service.reply({ requestID: request.id, reply: "reject" })
          expect(yield* requestCount(db, "permission_request", request.id)).toBe(0)
          expect(yield* service.reply({ requestID: request.id, reply: "reject" }).pipe(Effect.flip)).toEqual(
            new PermissionV2.NotFoundError({ requestID: request.id }),
          )
          yield* Scope.close(secondScope, Exit.void)
        }),
      ),
    ),
  )

  test("question remains replyable exactly once across teardown", () =>
    Effect.runPromise(
      withDatabase((db) =>
        Effect.gen(function* () {
          const firstScope = yield* Scope.make()
          const firstContext = yield* Layer.buildWithScope(Layer.fresh(graphForQuestion(db)), firstScope)
          const { fiber, request } = yield* waitForQuestion(firstContext)
          yield* Scope.close(firstScope, Exit.void)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("QuestionV2.RejectedError")

          const secondScope = yield* Scope.make()
          const eventContext = yield* Layer.buildWithScope(Layer.fresh(eventGraph(db)), secondScope)
          const events = Context.get(eventContext, EventV2.Service)
          let republished = 0
          yield* events.listen((event) =>
            Effect.sync(() => {
              if (event.type === QuestionV2.Event.Asked.type && (event.data as QuestionV2.Request).id === request.id)
                republished++
            }),
          )
          const secondContext = yield* Layer.buildWithScope(Layer.fresh(graphForQuestion(db, events)), secondScope)
          const service = Context.get(secondContext, QuestionV2.Service)
          expect((yield* service.list()).some((item) => item.id === request.id)).toBe(true)
          // Asked is non-durable; the in-process listener is the no-rerun authority.
          expect(republished).toBe(0)
          yield* service.reply({ requestID: request.id, answers: [["One"]] })
          expect(yield* requestCount(db, "question_request", request.id)).toBe(0)
          expect(yield* service.reply({ requestID: request.id, answers: [["One"]] }).pipe(Effect.flip)).toEqual(
            new QuestionV2.NotFoundError({ requestID: request.id }),
          )
          yield* Scope.close(secondScope, Exit.void)
        }),
      ),
    ),
  )

  test("question cancellation removes a rehydrated blocker", () =>
    Effect.runPromise(
      withDatabase((db) =>
        Effect.gen(function* () {
          const firstScope = yield* Scope.make()
          const firstContext = yield* Layer.buildWithScope(Layer.fresh(graphForQuestion(db)), firstScope)
          const { fiber, request } = yield* waitForQuestion(firstContext)
          yield* Scope.close(firstScope, Exit.void)
          yield* Fiber.await(fiber)
          const secondScope = yield* Scope.make()
          const secondContext = yield* Layer.buildWithScope(Layer.fresh(graphForQuestion(db)), secondScope)
          const service = Context.get(secondContext, QuestionV2.Service)
          yield* service.reject(request.id)
          expect(yield* requestCount(db, "question_request", request.id)).toBe(0)
          expect(yield* service.reply({ requestID: request.id, answers: [["One"]] }).pipe(Effect.flip)).toEqual(
            new QuestionV2.NotFoundError({ requestID: request.id }),
          )
          expect(yield* service.reject(request.id).pipe(Effect.flip)).toEqual(
            new QuestionV2.NotFoundError({ requestID: request.id }),
          )
          yield* Scope.close(secondScope, Exit.void)
        }),
      ),
    ),
  )

  // Positive control for the no-rerun assertions above (republished === 0 at the
  // rehydration sites). That assertion is only meaningful if the listener CAN
  // observe an Asked publish through the EventV2.node override that
  // graphForPermission/graphForQuestion inject. Attach the listener to the injected
  // instance BEFORE the creating context, trigger a genuine request, and assert the
  // publish landed for the same blocker id. If the override were removed the service
  // would publish to an internal instance this listener never sees — the count stays
  // 0 and this fails, surfacing the same vacuous-truth defect as a decoration.
  test("positive control: an injected event listener observes a genuine Asked publish", () =>
    Effect.runPromise(
      withDatabase((db) =>
        Effect.gen(function* () {
          const permissionScope = yield* Scope.make()
          const permissionEvents = Context.get(
            (yield* Layer.buildWithScope(Layer.fresh(eventGraph(db)), permissionScope)),
            EventV2.Service,
          )
          let permissionAsked = 0
          let permissionAskedID: string | undefined
          yield* permissionEvents.listen((event) =>
            Effect.sync(() => {
              if (event.type === PermissionV2.Event.Asked.type) {
                permissionAsked++
                permissionAskedID = (event.data as PermissionV2.Request).id
              }
            }),
          )
          const permissionContext = yield* Layer.buildWithScope(
            Layer.fresh(graphForPermission(db, permissionEvents)),
            permissionScope,
          )
          const { fiber: permissionFiber, request: permissionRequest } = yield* waitForPermission(permissionContext)
          expect(permissionAsked).toBeGreaterThan(0)
          expect(permissionAskedID).toBe(permissionRequest.id)
          yield* Scope.close(permissionScope, Exit.void)
          yield* Fiber.await(permissionFiber)

          const questionScope = yield* Scope.make()
          const questionEvents = Context.get(
            (yield* Layer.buildWithScope(Layer.fresh(eventGraph(db)), questionScope)),
            EventV2.Service,
          )
          let questionAsked = 0
          let questionAskedID: string | undefined
          yield* questionEvents.listen((event) =>
            Effect.sync(() => {
              if (event.type === QuestionV2.Event.Asked.type) {
                questionAsked++
                questionAskedID = (event.data as QuestionV2.Request).id
              }
            }),
          )
          const questionContext = yield* Layer.buildWithScope(
            Layer.fresh(graphForQuestion(db, questionEvents)),
            questionScope,
          )
          const { fiber: questionFiber, request: questionRequest } = yield* waitForQuestion(questionContext)
          expect(questionAsked).toBeGreaterThan(0)
          expect(questionAskedID).toBe(questionRequest.id)
          yield* Scope.close(questionScope, Exit.void)
          yield* Fiber.await(questionFiber)
        }),
      ),
    ),
  )
})
