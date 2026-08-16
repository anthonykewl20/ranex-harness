export * as SessionStore from "./store"

import { and, eq, isNull, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionHistory } from "./history"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionBlockerTable, SessionMessageTable, SessionTable } from "./sql"
import { fromRow } from "./info"
import { ExecutionOwner } from "./execution-owner"
import { SessionRecovery } from "./recovery"

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined>
  readonly list: () => Effect.Effect<ReadonlyArray<SessionSchema.Info>>
  readonly claimExecution: (sessionID: SessionSchema.ID, owner: string) => Effect.Effect<boolean>
  readonly releaseExecution: (sessionID: SessionSchema.ID, owner: string) => Effect.Effect<void>
  readonly executionOwner: (sessionID: SessionSchema.ID) => Effect.Effect<string | undefined>
  readonly context: (sessionID: SessionSchema.ID) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly runnerContext: (
    sessionID: SessionSchema.ID,
    baselineSeq: number,
  ) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly message: SessionMessage.Message } | undefined>
  readonly blockers: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Blocker>>
  readonly block: (input: BlockInput) => Effect.Effect<void>
  readonly resolveBlocker: (input: {
    readonly sessionID: SessionSchema.ID
    readonly id: string
    readonly actor: string
    readonly choice: SessionRecovery.Resolution
  }) => Effect.Effect<boolean>
}

export type Blocker = {
  readonly id: string
  readonly kind: "provider_in_flight" | "tool_side_effect_ambiguous"
  readonly assistantMessageID?: SessionMessage.ID
  readonly callID?: string
  readonly aggregateSeq: number
}

export type BlockInput = Blocker & { readonly sessionID: SessionSchema.ID }

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

    return Service.of({
      get: Effect.fn("SessionStore.get")(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      list: Effect.fn("SessionStore.list")(function* () {
        const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
        return rows.map(fromRow)
      }),
      claimExecution: Effect.fn("SessionStore.claimExecution")(function* (sessionID, owner) {
        const claim = Effect.fnUntraced(function* (attempt: number): Effect.fn.Return<boolean> {
          const row = yield* db
            .select({ execution_owner: SessionTable.execution_owner })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!row) return false
          const observed = row.execution_owner
          if (observed !== null && observed !== owner && (yield* Effect.promise(() => ExecutionOwner.isLive(observed))))
            return false
          const claimed = yield* db
            .update(SessionTable)
            .set({ execution_owner: owner })
            .where(
              and(
                eq(SessionTable.id, sessionID),
                observed === null
                  ? or(isNull(SessionTable.execution_owner), eq(SessionTable.execution_owner, owner))
                  : or(
                      isNull(SessionTable.execution_owner),
                      eq(SessionTable.execution_owner, observed),
                      eq(SessionTable.execution_owner, owner),
                    ),
              ),
            )
            .returning({ id: SessionTable.id })
            .get()
            .pipe(Effect.orDie)
          if (claimed !== undefined) return true
          if (attempt === 4) return false
          yield* Effect.yieldNow
          return yield* claim(attempt + 1)
        })
        return yield* claim(1)
      }),
      releaseExecution: Effect.fn("SessionStore.releaseExecution")(function* (sessionID, owner) {
        yield* db
          .update(SessionTable)
          .set({ execution_owner: null })
          .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.execution_owner, owner)))
          .run()
          .pipe(Effect.orDie)
      }),
      executionOwner: Effect.fn("SessionStore.executionOwner")(function* (sessionID) {
        const row = yield* db
          .select({ execution_owner: SessionTable.execution_owner })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        return row?.execution_owner ?? undefined
      }),
      context: Effect.fn("SessionStore.context")(function* (sessionID) {
        return yield* SessionHistory.load(db, sessionID)
      }),
      runnerContext: Effect.fn("SessionStore.runnerContext")(function* (sessionID, baselineSeq) {
        return yield* SessionHistory.loadForRunner(db, sessionID, baselineSeq)
      }),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        return row
          ? {
              sessionID: SessionSchema.ID.make(row.session_id),
              message: yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
            }
          : undefined
      }),
      blockers: Effect.fn("SessionStore.blockers")(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(SessionBlockerTable)
          .where(and(eq(SessionBlockerTable.session_id, sessionID), isNull(SessionBlockerTable.time_resolved)))
          .all()
          .pipe(Effect.orDie)
        return rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          assistantMessageID: row.assistant_message_id ? SessionMessage.ID.make(row.assistant_message_id) : undefined,
          callID: row.call_id ?? undefined,
          aggregateSeq: row.aggregate_seq,
        }))
      }),
      block: Effect.fn("SessionStore.block")(function* (input) {
        yield* db
          .insert(SessionBlockerTable)
          .values({
            id: input.id,
            session_id: input.sessionID,
            kind: input.kind,
            assistant_message_id: input.assistantMessageID,
            call_id: input.callID,
            aggregate_seq: input.aggregateSeq,
            time_created: Date.now(),
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }),
      resolveBlocker: Effect.fn("SessionStore.resolveBlocker")(function* (input) {
        const resolved = yield* db
          .update(SessionBlockerTable)
          .set({ actor: input.actor, resolution: input.choice, time_resolved: Date.now() })
          .where(
            and(
              eq(SessionBlockerTable.id, input.id),
              eq(SessionBlockerTable.session_id, input.sessionID),
              isNull(SessionBlockerTable.time_resolved),
            ),
          )
          .returning({ id: SessionBlockerTable.id })
          .get()
          .pipe(Effect.orDie)
        return resolved !== undefined
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
