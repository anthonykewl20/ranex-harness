export * as PermissionV2 from "./permission"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect as EffectRuntime, Layer, Option, Schema } from "effect"
import { Permission } from "@ranex/schema/permission"
import { EventV2 } from "./event"
import { Location } from "./location"
import { ProjectResolution } from "./project-resolution"
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

// Delegation-level bound on what an assert may allow. Scope only narrows:
// allow decisions stand solely for targets inside the scope, while deny and
// ask decisions are unaffected. An omitted scope keeps legacy behavior.
// Scope vocabularies are kind-bound (see `pathScopedActions` /
// `serverScopedActions` below): a scope can only vouch for action kinds whose
// resources it can reason about, and any scope present on an unbound action
// degrades allow → ask — fail closed.
export const Scope = Schema.Struct({
  // Workspace-relative path or glob bounds in rule-resource wildcard syntax
  // (`src/**`), matched with the engine's own wildcard matcher. Binds only to
  // the path-resourced actions (`read`, `edit`, `external_directory`); on any
  // other action a present `paths` scope degrades allow → ask.
  paths: Schema.Array(Schema.String).pipe(Schema.optional),
  // MCP server IDs; a target names a listed server as the exact ID or as a
  // `server/...` / `server:...` prefixed resource. Binds only to the `mcp`
  // action; on any other action a present `servers` scope degrades
  // allow → ask.
  servers: Schema.Array(Schema.String).pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.Scope" })
export type Scope = typeof Scope.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
  scope: Scope.pipe(Schema.optional),
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

// Bash approval rules never match when either side carries shell control characters, so
// compound or piped commands cannot inherit a prefix approval and fall through to ask.
// Substitution ($ and parentheses) and redirection (< and >) are live execution
// primitives in a real shell, so they join the rejected set.
const bashControlChars = /[;|&`\n$()<>]/

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast(
        (rule) =>
          Wildcard.match(action, rule.action) &&
          // POSIX allow rules match resource casing strictly so `allow
          // Secrets/*` cannot widen to `secrets/x`; deny/ask rules stay broad
          // to prevent casing bypass. win32 is case-insensitive throughout.
          Wildcard.match(resource, rule.resource, {
            caseInsensitive: process.platform === "win32" || rule.effect !== "allow",
          }) &&
          !(action === "bash" && (bashControlChars.test(rule.resource) || bashControlChars.test(resource))),
      ) ?? {
        action,
        resource: "*",
        effect: "ask",
      }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

// Scope narrows allows only: an allow for a target outside the delegation's
// scope degrades to ask — the engine's non-allow outcome — so scope can never
// widen access and never mutes a deny.
function scopedEvaluate(
  action: string,
  resource: string,
  rules: Permission.Ruleset,
  scope: Scope | undefined,
): Permission.Effect {
  const effect = evaluate(action, resource, rules).effect
  if (effect !== "allow" || !scope) return effect
  return inScope(action, scope, resource) ? effect : "ask"
}

// Scope vocabularies are bound to action kinds, mirroring the concrete V2
// assert sites: `read` (tool/read.ts) and `edit` (tool/edit.ts, write.ts,
// apply-patch.ts) resources are workspace paths, and `external_directory`
// (location-mutation.ts) resources are canonical directory globs — all
// matched by the `paths` vocabulary. The `servers` vocabulary applies only
// to the `mcp` action, whose resources name MCP servers. Every other action
// (bash commands, web URLs, search patterns, skill or question targets) has
// no vocabulary, so a scope present on it degrades allow → ask: a scoped
// delegation must never allow an action kind the scope cannot reason about.
const pathScopedActions = new Set(["read", "edit", "external_directory"])
const serverScopedActions = new Set(["mcp"])

function inScope(action: string, scope: Scope, resource: string) {
  if (pathScopedActions.has(action)) {
    // Path bounds keep the allow-rule casing convention: strict on POSIX so
    // scope `src/**` cannot be satisfied by `SRC/x`, insensitive on win32.
    const paths = scope.paths ?? []
    if (paths.some((pattern) => Wildcard.match(resource, pattern, { caseInsensitive: process.platform === "win32" })))
      return true
  }
  if (serverScopedActions.has(action)) {
    const servers = scope.servers ?? []
    // Server membership is exact-ID with a separator boundary, so listing
    // `github` never admits `githubevil/x` or `my_github/x`. Empty IDs are
    // skipped so `servers: [""]` can never match via the `"/..."` prefix on
    // absolute paths.
    if (
      servers.some(
        (server) =>
          server !== "" && (resource === server || resource.startsWith(server + "/") || resource.startsWith(server + ":")),
      )
    )
      return true
  }
  return false
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
  // The assert-time scope, persisted beside the request and restored across
  // restarts; rows without a scope restore unscoped, and a stored scope that
  // parses but fails schema decoding restores as empty (matching nothing);
  // malformed bytes fail boot like the `data` column.
  readonly scope?: Scope
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const resolution = yield* ProjectResolution.Service
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
          // A persisted scope is untrusted across a restart: a truthy value
          // that parses as JSON but fails schema decoding restores as an
          // empty scope — matching nothing, still narrowed, never widened.
          // Malformed bytes throw in the driver's JSON.parse inside the
          // orDie-wrapped select, failing location boot like the `data`
          // column; a null scope (SQL NULL or JSON null) restores unscoped
          // as a legacy row.
          const scope = row.scope
            ? Option.getOrElse(Schema.decodeUnknownOption(Scope)(row.scope), () => ({}))
            : undefined
          pending.set(request.id, {
            request,
            agent: row.agent ?? undefined,
            scope,
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
      const ready = yield* resolution.awaitReady().pipe(EffectRuntime.catch(() => EffectRuntime.succeed(undefined)))
      if (!ready) return []
      return (yield* saved.list({ projectID: ready.project.id })).map(
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
      const effects = input.resources.map((resource) => scopedEvaluate(input.action, resource, all, input.scope))
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

    const create = (request: Request, agent?: AgentV2.ID, scope?: Scope) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item = { request, agent, scope, deferred }
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
                    .values({ id: request.id, session_id: request.sessionID, data: request, agent, scope })
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
      if (result.effect === "ask") yield* create(value, input.agent, input.scope)
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
          const item = yield* create(request(input), input.agent, input.scope)
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
          const projectID = save?.length
            ? (
                yield* resolution
                .awaitReady()
                .pipe(
                  EffectRuntime.catch(() =>
                    EffectRuntime.fail(new SettlementError({ requestID: input.requestID })),
                  ),
                )
              ).project.id
            : undefined
          const won = save?.length && projectID
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
                        projectID,
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
                    (resource) => scopedEvaluate(item.request.action, resource, effective, item.scope) === "allow",
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
  deps: [
    Database.node,
    EventV2.node,
    Location.node,
    AgentV2.node,
    SessionStore.node,
    PermissionSaved.node,
    ProjectResolution.node,
  ],
})
