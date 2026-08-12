export * as QuestionV2 from "./question"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Question } from "@ranex/schema/question"
import { EventV2 } from "./event"
import { SessionSchema } from "./session/schema"
import { Database } from "./database/database"
import { QuestionRequestTable } from "./question/sql"
import { eq } from "drizzle-orm"

export const ID = Question.ID
export type ID = typeof ID.Type

export const Option = Question.Option
export type Option = typeof Option.Type

export const Info = Question.Info
export type Info = typeof Info.Type

export const Prompt = Question.Prompt
export type Prompt = typeof Prompt.Type

export const Tool = Question.Tool
export type Tool = typeof Tool.Type

export const Request = Question.Request
export type Request = typeof Request.Type

export const Answer = Question.Answer
export type Answer = typeof Answer.Type

export const Reply = Question.Reply
export type Reply = typeof Reply.Type

export const Event = Question.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionV2.RejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("QuestionV2.NotFoundError", {
  requestID: ID,
}) {}

export interface AskInput {
  readonly sessionID: SessionSchema.ID
  readonly questions: ReadonlyArray<Info>
  readonly tool?: Tool
}

export interface ReplyInput {
  readonly requestID: ID
  readonly answers: ReadonlyArray<Answer>
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: ID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Question") {}

interface Pending {
  readonly request: Request
  readonly deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
}

/**
 * Location-owned pending prompts. The Location layer map must materialize this
 * layer once per embedded Location so replies cannot settle another Location's
 * deferred request.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    const pending = new Map<ID, Pending>()

    yield* Effect.forEach(yield* db.select().from(QuestionRequestTable).all().pipe(Effect.orDie), (row) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(Request)(row.data).pipe(Effect.orDie)
        pending.set(request.id, {
          request,
          deferred: yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>(),
        })
      }),
    )

    yield* Effect.addFinalizer(() =>
      Effect.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new RejectedError()), {
        discard: true,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const claimSettlement = (requestID: ID) =>
      db
        .delete(QuestionRequestTable)
        .where(eq(QuestionRequestTable.id, requestID))
        .returning()
        .get()
        .pipe(Effect.orDie)

    const ask = Effect.fn("QuestionV2.ask")((input: AskInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const id = ID.ascending()
          const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
          const request: Request = { id, ...input }
          pending.set(id, { request, deferred })
          yield* db
            .insert(QuestionRequestTable)
            .values({ id, session_id: request.sessionID, data: request })
            .run()
            .pipe(
              Effect.onError(() => Effect.sync(() => pending.delete(id))),
              Effect.orDie,
            )
          yield* events.publish(Event.Asked, request).pipe(
            Effect.onError(() =>
              Effect.gen(function* () {
                pending.delete(id)
                yield* db.delete(QuestionRequestTable).where(eq(QuestionRequestTable.id, id)).run().pipe(Effect.orDie)
              }),
            ),
          )
          return yield* restore(Deferred.await(deferred)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = Effect.fn("QuestionV2.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const won = yield* claimSettlement(input.requestID)
          if (!won) return yield* new NotFoundError({ requestID: input.requestID })
          const existing = pending.get(input.requestID)
          if (!existing) return yield* Effect.die(`Missing pending question Deferred: ${input.requestID}`)
          yield* Deferred.succeed(existing.deferred, input.answers)
          pending.delete(input.requestID)
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            answers: input.answers.map((answer) => [...answer]),
          })
        }),
      ),
    )

    const reject = Effect.fn("QuestionV2.reject")((requestID: ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const won = yield* claimSettlement(requestID)
          if (!won) return yield* new NotFoundError({ requestID })
          const existing = pending.get(requestID)
          if (!existing) return yield* Effect.die(`Missing pending question Deferred: ${requestID}`)
          yield* Deferred.fail(existing.deferred, new RejectedError())
          pending.delete(requestID)
          yield* events.publish(Event.Rejected, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
          })
        }),
      ),
    )

    const list = Effect.fn("QuestionV2.list")(function* () {
      const rows = yield* db.select().from(QuestionRequestTable).all().pipe(Effect.orDie)
      return yield* Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(Request)(row.data).pipe(Effect.orDie))
    })

    return Service.of({ ask, reply, reject, list })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
