export * as PermissionV2 from "./permission"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect as EffectRuntime, Layer, Schema } from "effect"
import { Permission } from "@ranex/schema/permission"
import { EventV2 } from "./event"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { SessionV2 } from "./session"
import { SessionStore } from "./session/store"
import { Wildcard } from "./util/wildcard"
import { PermissionSaved } from "./permission/saved"
import { Database } from "./database/database"
import { PermissionRequestTable } from "./permission/sql"
import { and, eq, isNull } from "drizzle-orm"
import { SessionTable } from "./session/sql"

export { Effect, Rule, Ruleset } from "@ranex/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class DeclinedError extends Schema.TaggedErrorClass<DeclinedError>()("PermissionV2.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("PermissionV2.BlockedError", {
  rules: Permission.Ruleset,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

export class SettlementError extends Schema.TaggedErrorClass<SettlementError>()("PermissionV2.SettlementError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionV2.NotFoundError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionV2.NotFoundError>
  readonly reply: (input: ReplyInput) => EffectRuntime.Effect<void, NotFoundError | SettlementError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionV2.ID) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: AgentV2.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const { db } = yield* Database.Service
    const pending = new Map<ID, Pending>()

    const ownsSession = (session: SessionV2.Info) =>
      session.location.directory === location.directory && session.location.workspaceID === location.workspaceID
    const sessionIDs = new Set((yield* sessions.list()).filter(ownsSession).map((session) => session.id))

    yield* EffectRuntime.forEach(
      (yield* db.select().from(PermissionRequestTable).all().pipe(EffectRuntime.orDie)).filter((row) =>
        sessionIDs.has(row.session_id),
      ),
      (row) =>
        EffectRuntime.gen(function* () {
          const request = yield* Schema.decodeUnknownEffect(Request)(row.data).pipe(EffectRuntime.orDie)
          pending.set(request.id, {
            request,
            agent: row.agent ?? undefined,
            deferred: yield* Deferred.make<void, DeclinedError | CorrectedError>(),
          })
        }),
    )

    yield* EffectRuntime.addFinalizer(() =>
      EffectRuntime.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new DeclinedError()), {
        discard: true,
      }).pipe(
        EffectRuntime.ensuring(
          EffectRuntime.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const savedRules = EffectRuntime.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
      )
    })

    const configured = EffectRuntime.fn("PermissionV2.configured")(function* (
      sessionID: SessionV2.ID,
      agentID?: AgentV2.ID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session || !ownsSession(session)) return yield* new SessionV2.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return agent?.permissions ?? missingAgentPermissions
    })

    function denied(input: AssertInput, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const evaluateInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      const rules = yield* configured(input.sessionID, input.agent)
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const all = [...rules, ...(yield* savedRules())]
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      return { effect, rules: all }
    })

    function request(input: AssertInput): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
      }
    }

    const create = (request: Request, agent?: AgentV2.ID) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item = { request, agent, deferred }
          if (pending.has(request.id)) return yield* EffectRuntime.die(`Duplicate pending permission ID: ${request.id}`)
          const admitted = yield* db
            .transaction(
              (tx) =>
                EffectRuntime.gen(function* () {
                  const session = yield* tx
                    .select({ id: SessionTable.id })
                    .from(SessionTable)
                    .where(
                      and(
                        eq(SessionTable.id, request.sessionID),
                        eq(SessionTable.directory, location.directory),
                        location.workspaceID
                          ? eq(SessionTable.workspace_id, location.workspaceID)
                          : isNull(SessionTable.workspace_id),
                      ),
                    )
                    .get()
                    .pipe(EffectRuntime.orDie)
                  if (!session) return false
                  yield* tx
                    .insert(PermissionRequestTable)
                    .values({ id: request.id, session_id: request.sessionID, data: request, agent })
                    .run()
                    .pipe(EffectRuntime.orDie)
                  return true
                }),
              { behavior: "immediate" },
            )
            .pipe(EffectRuntime.orDie)
          if (!admitted) return yield* new SessionV2.NotFoundError({ sessionID: request.sessionID })
          pending.set(request.id, item)
          yield* events
            .publish(Event.Asked, request)
            .pipe(
              EffectRuntime.onError(() =>
                EffectRuntime.gen(function* () {
                  pending.delete(request.id)
                  yield* db
                    .delete(PermissionRequestTable)
                    .where(eq(PermissionRequestTable.id, request.id))
                    .run()
                    .pipe(EffectRuntime.orDie)
                }),
              ),
            )
          return item
        }),
      )

    const claimSettlement = (requestID: ID) =>
      db
        .delete(PermissionRequestTable)
        .where(eq(PermissionRequestTable.id, requestID))
        .returning()
        .get()
        .pipe(EffectRuntime.orDie)

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      const value = request(input)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assert = EffectRuntime.fn("PermissionV2.assert")((input: AssertInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const result = yield* evaluateInput(input)
          if (result.effect === "deny") {
            return yield* new BlockedError({
              rules: relevant(input, result.rules),
            })
          }
          if (result.effect === "allow") return
          const item = yield* create(request(input), input.agent)
          return yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.catchTag("PermissionV2.DeclinedError", (error) => EffectRuntime.die(error)),
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                pending.delete(item.request.id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = EffectRuntime.fn("PermissionV2.reply")((input: ReplyInput) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })

          const save = input.reply === "always" ? existing.request.save : undefined
          const won = save?.length
            ? yield* db
                .transaction((tx) =>
                  EffectRuntime.gen(function* () {
                    const claimed = yield* tx
                      .delete(PermissionRequestTable)
                      .where(eq(PermissionRequestTable.id, input.requestID))
                      .returning()
                      .get()
                    if (!claimed) return undefined
                    yield* saved.add(
                      {
                        projectID: location.project.id,
                        action: existing.request.action,
                        resources: save,
                      },
                      tx,
                    )
                    return claimed
                  }),
                )
                .pipe(
                  EffectRuntime.catchCause(() =>
                    EffectRuntime.fail(new SettlementError({ requestID: input.requestID })),
                  ),
                )
            : yield* claimSettlement(input.requestID)
          if (!won) return yield* new NotFoundError({ requestID: input.requestID })

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            pending.delete(input.requestID)
            yield* events.publish(Event.Replied, {
              sessionID: existing.request.sessionID,
              requestID: existing.request.id,
              reply: input.reply,
            })
            yield* EffectRuntime.forEach(
              Array.from(pending.values()).filter(
                (item) => item.request.sessionID === existing.request.sessionID,
              ),
              (item) =>
                EffectRuntime.gen(function* () {
                  const claimed = yield* claimSettlement(item.request.id)
                  if (!claimed) return
                  yield* Deferred.fail(item.deferred, new DeclinedError())
                  pending.delete(item.request.id)
                  yield* events.publish(Event.Replied, {
                    sessionID: item.request.sessionID,
                    requestID: item.request.id,
                    reply: "reject",
                  })
                }),
              { discard: true },
            )
            return
          }

          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })
          if (input.reply !== "always" || !existing.request.save?.length) return

          const rememberedRules = yield* savedRules()
          yield* EffectRuntime.forEach(
            Array.from(pending.values()),
            (item) =>
              EffectRuntime.gen(function* () {
                const rules = yield* configured(item.request.sessionID, item.agent).pipe(
                  EffectRuntime.catchTag("Session.NotFoundError", () => EffectRuntime.succeed(undefined)),
                )
                if (!rules || denied(item.request, rules)) return
                const effective = [...rules, ...rememberedRules]
                if (
                  !item.request.resources.every(
                    (resource) => evaluate(item.request.action, resource, effective).effect === "allow",
                  )
                )
                  return
                const claimed = yield* claimSettlement(item.request.id)
                if (!claimed) return
                yield* Deferred.succeed(item.deferred, undefined)
                pending.delete(item.request.id)
                yield* events.publish(Event.Replied, {
                  sessionID: item.request.sessionID,
                  requestID: item.request.id,
                  reply: "always",
                })
              }),
            { discard: true },
          )
        }),
      ),
    )

    const list = EffectRuntime.fn("PermissionV2.list")(function* () {
      return yield* EffectRuntime.forEach(pending.values(), (item) =>
        EffectRuntime.succeed(item.request),
      )
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      if (!pending.has(id)) return undefined
      const row = yield* db
        .select()
        .from(PermissionRequestTable)
        .where(eq(PermissionRequestTable.id, id))
        .get()
        .pipe(EffectRuntime.orDie)
      if (!row) return undefined
      return yield* Schema.decodeUnknownEffect(Request)(row.data).pipe(EffectRuntime.orDie)
    })

    const forSession = EffectRuntime.fn("PermissionV2.forSession")(function* (sessionID: SessionV2.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session || !ownsSession(session)) return []
      const rows = yield* db
        .select()
        .from(PermissionRequestTable)
        .where(eq(PermissionRequestTable.session_id, sessionID))
        .all()
        .pipe(EffectRuntime.orDie)
      return yield* EffectRuntime.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(Request)(row.data).pipe(EffectRuntime.orDie),
      )
    })

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, Location.node, AgentV2.node, SessionStore.node, PermissionSaved.node],
})
