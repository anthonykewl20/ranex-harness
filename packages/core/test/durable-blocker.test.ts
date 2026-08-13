import { describe, expect, test } from "bun:test"
import path from "path"
import { Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { AgentV2 } from "@ranex/core/agent"
import { Database } from "@ranex/core/database/database"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { EventV2 } from "@ranex/core/event"
import { Location } from "@ranex/core/location"
import { PermissionV2 } from "@ranex/core/permission"
import { PermissionRequestTable, PermissionTable } from "@ranex/core/permission/sql"
import { PermissionSaved } from "@ranex/core/permission/saved"
import { Project } from "@ranex/core/project"
import { ProjectTable } from "@ranex/core/project/sql"
import { QuestionV2 } from "@ranex/core/question"
import { QuestionRequestTable } from "@ranex/core/question/sql"
import { AbsolutePath } from "@ranex/core/schema"
import { SessionV2 } from "@ranex/core/session"
import { SessionTable } from "@ranex/core/session/sql"
import { SessionStore } from "@ranex/core/session/store"
import { eq, sql } from "drizzle-orm"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

const sessionID = SessionV2.ID.make("ses_durable_blocker")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const other = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/other") })),
)
const question = {
  question: "Which option?",
  header: "Option",
  options: [{ label: "One", description: "First option" }],
} satisfies QuestionV2.Info

function layer(filename: string, locationLayer = current) {
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
      QuestionV2.node,
    ]),
    [
      [Database.node, Database.layerFromPath(filename)],
      [Location.node, locationLayer],
    ],
  )
}

function graph<A, E>(filename: string, effect: Effect.Effect<A, E, Scope.Scope | PermissionV2.Service | QuestionV2.Service | EventV2.Service | Database.Service | AgentV2.Service>, locationLayer = current) {
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layer(filename, locationLayer))))
}

const setup = Effect.gen(function* () {
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
      slug: "durable",
      directory: "/project",
      title: "durable",
      version: "test",
      agent: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const agents = yield* AgentV2.Service
  yield* agents.transform((editor) =>
    editor.update(AgentV2.ID.make("test"), (agent) => {
      agent.permissions = []
    }),
  )
})

function permission(id: string, input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create(id),
    sessionID,
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

const askQuestion = Effect.gen(function* () {
  const service = yield* QuestionV2.Service
  const events = yield* EventV2.Service
  const asked = yield* Deferred.make<QuestionV2.Request>()
  const unsubscribe = yield* events.listen((event) =>
    event.type === QuestionV2.Event.Asked.type
      ? Deferred.succeed(asked, event.data as QuestionV2.Request).pipe(Effect.asVoid)
      : Effect.void,
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  yield* service.ask({ sessionID, questions: [question] }).pipe(Effect.forkScoped)
  return yield* Deferred.await(asked)
})

describe("durable permission and question blockers", () => {
  test("permission once survives teardown and settles exactly once", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blockers.sqlite")
    const request = await graph(filename, Effect.gen(function* () {
      yield* setup
      const service = yield* PermissionV2.Service
      const result = yield* service.ask(permission("per_durable_once"))
      return (yield* service.get(result.id))!
    }))
    await graph(filename, Effect.gen(function* () {
      const service = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      let replied = 0
      const unsubscribe = yield* events.listen((event) => Effect.sync(() => {
        if (event.type === PermissionV2.Event.Replied.type) replied++
      }))
      yield* Effect.addFinalizer(() => unsubscribe)
      expect((yield* service.list()).map((item) => item.id)).toContain(request.id)
      yield* service.reply({ requestID: request.id, reply: "once" })
      expect(replied).toBe(1)
      expect(yield* service.reply({ requestID: request.id, reply: "once" }).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.NotFoundError)
    }))
    expect(await graph(filename, PermissionV2.Service.use((service) => service.get(request.id)))).toBeUndefined()
  })

  test("permission rejection survives teardown", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blockers.sqlite")
    const id = PermissionV2.ID.create("per_durable_reject")
    await graph(filename, Effect.gen(function* () {
      yield* setup
      const service = yield* PermissionV2.Service
      yield* service.ask(permission(id))
    }))
    await graph(filename, Effect.gen(function* () {
      const service = yield* PermissionV2.Service
      expect((yield* service.forSession(sessionID)).map((item) => item.id)).toContain(id)
      yield* service.reply({ requestID: id, reply: "reject" })
      expect(yield* service.reply({ requestID: id, reply: "reject" }).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.NotFoundError)
    }))
    expect(await graph(filename, Database.Service.use(({ db }) => db.select().from(PermissionRequestTable).where(eq(PermissionRequestTable.id, id)).get().pipe(Effect.orDie)))).toBeUndefined()
  })

  test("permission hydration and settlement are scoped to the owning location", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blockers.sqlite")
    const localID = PermissionV2.ID.create("per_location_local")
    const otherID = PermissionV2.ID.create("per_location_other")
    const otherSessionID = SessionV2.ID.make("ses_durable_blocker_other")
    await graph(filename, Effect.gen(function* () {
      yield* setup
      const service = yield* PermissionV2.Service
      yield* service.ask(permission(localID))
    }))
    await graph(filename, Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: otherSessionID,
          project_id: Project.ID.global,
          slug: "other",
          directory: "/other",
          title: "other",
          version: "test",
          agent: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("test"), (agent) => {
          agent.permissions = []
        }),
      )
      const service = yield* PermissionV2.Service
      yield* service.ask(permission(otherID, { sessionID: otherSessionID }))
    }), other)
    await graph(filename, Effect.gen(function* () {
      const service = yield* PermissionV2.Service
      expect((yield* service.list()).map((item) => item.id)).toEqual([localID])
      expect(yield* service.forSession(otherSessionID)).toEqual([])
      expect(yield* service.get(otherID)).toBeUndefined()
      expect(yield* service.reply({ requestID: otherID, reply: "once" }).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.NotFoundError)
    }))
    await graph(filename, Effect.gen(function* () {
      const service = yield* PermissionV2.Service
      expect((yield* service.list()).map((item) => item.id)).toEqual([otherID])
      yield* service.reply({ requestID: otherID, reply: "once" })
    }), other)
  })

  test("question reply survives teardown and settles exactly once", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blockers.sqlite")
    const request = await graph(filename, Effect.gen(function* () {
      yield* setup
      return yield* askQuestion
    }))
    await graph(filename, Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      let replied = 0
      const unsubscribe = yield* events.listen((event) => Effect.sync(() => {
        if (event.type === QuestionV2.Event.Replied.type) replied++
      }))
      yield* Effect.addFinalizer(() => unsubscribe)
      expect((yield* service.list()).map((item) => item.id)).toContain(request.id)
      yield* service.reply({ requestID: request.id, answers: [["One"]] })
      expect(replied).toBe(1)
      expect(yield* service.reply({ requestID: request.id, answers: [] }).pipe(Effect.flip)).toBeInstanceOf(QuestionV2.NotFoundError)
    }))
    expect(await graph(filename, QuestionV2.Service.use((service) => service.list()))).toEqual([])
  })

  test("question cancellation survives teardown", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blockers.sqlite")
    const request = await graph(filename, Effect.gen(function* () {
      yield* setup
      return yield* askQuestion
    }))
    await graph(filename, Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      yield* service.reject(request.id)
      expect(yield* service.reject(request.id).pipe(Effect.flip)).toBeInstanceOf(QuestionV2.NotFoundError)
    }))
    expect(await graph(filename, Database.Service.use(({ db }) => db.select().from(QuestionRequestTable).where(eq(QuestionRequestTable.id, request.id)).get().pipe(Effect.orDie)))).toBeUndefined()
  })

  test("question hydration and settlement are scoped to the owning location", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blockers.sqlite")
    const otherSessionID = SessionV2.ID.make("ses_question_blocker_other")
    const hydratedID = await graph(filename, Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: otherSessionID,
          project_id: Project.ID.global,
          slug: "question-other",
          directory: "/other",
          title: "question other",
          version: "test",
          agent: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const service = yield* QuestionV2.Service
      const first = yield* askQuestionFor(service, otherSessionID)

      yield* Effect.promise(() => graph(filename, Effect.gen(function* () {
        const foreign = yield* QuestionV2.Service
        expect(yield* foreign.list()).toEqual([])
        expect(yield* foreign.reply({ requestID: first.request.id, answers: [["One"]] }).pipe(Effect.flip)).toBeInstanceOf(QuestionV2.NotFoundError)
        const { db } = yield* Database.Service
        expect(yield* db.select().from(QuestionRequestTable).where(eq(QuestionRequestTable.id, first.request.id)).get().pipe(Effect.orDie)).toBeDefined()
      }))).pipe(Effect.orDie)

      yield* service.reply({ requestID: first.request.id, answers: [["One"]] })
      expect(yield* Fiber.join(first.fiber)).toEqual([["One"]])

      const second = yield* askQuestionFor(service, otherSessionID)
      yield* Effect.promise(() => graph(filename, Effect.gen(function* () {
        const foreign = yield* QuestionV2.Service
        expect(yield* foreign.reject(second.request.id).pipe(Effect.flip)).toBeInstanceOf(QuestionV2.NotFoundError)
        const { db } = yield* Database.Service
        expect(yield* db.select().from(QuestionRequestTable).where(eq(QuestionRequestTable.id, second.request.id)).get().pipe(Effect.orDie)).toBeDefined()
      }))).pipe(Effect.orDie)
      yield* service.reject(second.request.id)
      expect(Exit.isFailure(yield* Fiber.await(second.fiber))).toBe(true)

      const hydrated = yield* askQuestionFor(service, otherSessionID)
      return hydrated.request.id
    }), other)

    await graph(filename, Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      expect(yield* service.list()).toEqual([])
      expect(yield* service.reject(hydratedID).pipe(Effect.flip)).toBeInstanceOf(QuestionV2.NotFoundError)
      const { db } = yield* Database.Service
      expect(yield* db.select().from(QuestionRequestTable).where(eq(QuestionRequestTable.id, hydratedID)).get().pipe(Effect.orDie)).toBeDefined()
    }))
    await graph(filename, Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      expect((yield* service.list()).map((item) => item.id)).toEqual([hydratedID])
      yield* service.reply({ requestID: hydratedID, answers: [["One"]] })
    }), other)
  })

  test("rehydration does not republish permission or question Asked", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blockers.sqlite")
    const original = await graph(filename, Effect.gen(function* () {
      yield* setup
      const events = yield* EventV2.Service
      const service = yield* PermissionV2.Service
      const counts = { permission: 0, question: 0 }
      const unsubscribe = yield* events.listen((event) => Effect.sync(() => {
        if (event.type === PermissionV2.Event.Asked.type) counts.permission++
        if (event.type === QuestionV2.Event.Asked.type) counts.question++
      }))
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* service.ask(permission("per_no_rerun"))
      yield* askQuestion
      return counts
    }))
    expect(original).toEqual({ permission: 1, question: 1 })
    const counts = { permission: 0, question: 0 }
    const eventSpy = Layer.succeed(EventV2.Service, EventV2.Service.of({
      publish: (definition, data) => Effect.sync(() => {
        if (definition.type === PermissionV2.Event.Asked.type) counts.permission++
        if (definition.type === QuestionV2.Event.Asked.type) counts.question++
        return { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
      }),
      subscribe: () => Stream.empty,
      all: () => Stream.empty,
      durable: () => Stream.empty,
      listen: () => Effect.succeed(Effect.void),
      project: () => Effect.void,
      replay: () => Effect.void,
      replayAll: () => Effect.succeed(undefined),
      remove: () => Effect.void,
      claim: () => Effect.void,
    }))
    const republished = await Effect.runPromise(Effect.gen(function* () {
      const permissions = yield* PermissionV2.Service
      yield* QuestionV2.Service
      const observed = { ...counts }
      const events = yield* EventV2.Service
      yield* events.publish(PermissionV2.Event.Asked, (yield* permissions.list())[0]!)
      expect(counts.permission).toBe(1)
      return observed
    }).pipe(
      Effect.scoped,
      Effect.provide(AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          EventV2.node,
          SessionStore.node,
          PermissionSaved.node,
          AgentV2.node,
          PermissionV2.node,
          QuestionV2.node,
        ]),
        [
          [Database.node, Database.layerFromPath(filename)],
          [EventV2.node, eventSpy],
          [Location.node, current],
        ],
      )),
    ))
    expect(republished).toEqual({ permission: 0, question: 0 })
  })

  test("concurrent same-ID replies have one winner and one observed Replied", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blockers.sqlite")
    const id = PermissionV2.ID.create("per_concurrent")
    await graph(filename, Effect.gen(function* () {
      yield* setup
      const service = yield* PermissionV2.Service
      yield* service.ask(permission(id))
    }))
    await graph(filename, Effect.gen(function* () {
      const service = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const replied: PermissionV2.ID[] = []
      const unsubscribe = yield* events.listen((event) => Effect.sync(() => {
        if (event.type === PermissionV2.Event.Replied.type) replied.push((event.data as { requestID: PermissionV2.ID }).requestID)
      }))
      yield* Effect.addFinalizer(() => unsubscribe)
      const exits = yield* Effect.all([
        service.reply({ requestID: id, reply: "once" }).pipe(Effect.exit),
        service.reply({ requestID: id, reply: "once" }).pipe(Effect.exit),
      ], { concurrency: "unbounded" })
      expect(exits.filter(Exit.isSuccess)).toHaveLength(1)
      expect(exits.filter(Exit.isFailure)).toHaveLength(1)
      expect(exits.find(Exit.isFailure)!.cause.toString()).toContain("PermissionV2.NotFoundError")
      expect(replied).toEqual([id])
    }))
  })

  test("a losing always reply does not persist its grant", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blockers.sqlite")
    const id = PermissionV2.ID.create("per_lost_always")
    await graph(filename, Effect.gen(function* () {
      yield* setup
      const service = yield* PermissionV2.Service
      yield* service.ask(permission(id, { save: ["src/*"] }))
    }))
    await graph(filename, Effect.gen(function* () {
      const service = yield* PermissionV2.Service
      yield* Effect.promise(() => graph(filename, PermissionV2.Service.use((winner) =>
        winner.reply({ requestID: id, reply: "once" }),
      ))).pipe(Effect.orDie)
      expect(yield* service.reply({ requestID: id, reply: "always" }).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.NotFoundError)
      const { db } = yield* Database.Service
      expect(yield* db.select().from(PermissionTable).all().pipe(Effect.orDie)).toEqual([])
    }))
  })

  test("reject cascades through same-session durable blockers", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blockers.sqlite")
    const ids = [PermissionV2.ID.create("per_cascade_1"), PermissionV2.ID.create("per_cascade_2")]
    await graph(filename, Effect.gen(function* () {
      yield* setup
      const service = yield* PermissionV2.Service
      yield* Effect.forEach(ids, (id) => service.ask(permission(id)), { discard: true })
    }))
    await graph(filename, Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("test"), (agent) => {
          agent.permissions = []
        }),
      )
      const service = yield* PermissionV2.Service
      yield* service.reply({ requestID: ids[0]!, reply: "reject" })
      expect(yield* service.list()).toEqual([])
      expect(yield* service.reply({ requestID: ids[1]!, reply: "once" }).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.NotFoundError)
    }))
  })

  test("always remember auto-satisfies matching durable blockers", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blockers.sqlite")
    const ids = [PermissionV2.ID.create("per_always_1"), PermissionV2.ID.create("per_always_2")]
    await graph(filename, Effect.gen(function* () {
      yield* setup
      const service = yield* PermissionV2.Service
      yield* service.ask(permission(ids[0]!, { save: ["src/*"] }))
      yield* service.ask(permission(ids[1]!, { resources: ["src/other.ts"] }))
    }))
    await graph(filename, Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("test"), (agent) => {
          agent.permissions = []
        }),
      )
      const service = yield* PermissionV2.Service
      yield* service.reply({ requestID: ids[0]!, reply: "always" })
      expect(yield* service.list()).toEqual([])
      expect(yield* service.reply({ requestID: ids[1]!, reply: "once" }).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.NotFoundError)
    }))
  })

  test("corrupt durable rows fail rehydration with a decode defect", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "blockers.sqlite")
    await graph(filename, setup)
    await graph(filename, Database.Service.use(({ db }) =>
      db.run(sql`INSERT INTO question_request (id, session_id, data, time_created, time_updated) VALUES ('que_corrupt', ${sessionID}, ${JSON.stringify({ id: "que_corrupt" })}, 1, 1)`).pipe(Effect.orDie),
    ))
    await expect(graph(filename, QuestionV2.Service)).rejects.toThrow('Missing key\n  at ["sessionID"]')
  })
})

function askQuestionFor(service: QuestionV2.Interface, targetSessionID: SessionV2.ID) {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<QuestionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === QuestionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as QuestionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.ask({ sessionID: targetSessionID, questions: [question] }).pipe(Effect.forkScoped)
    return { fiber, request: yield* Deferred.await(asked) }
  })
}
