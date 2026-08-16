export * as SessionReconcile from "./reconcile"

import { DateTime, Effect, Exit, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EffectFlock } from "../util/effect-flock"
import { SessionEvent } from "./event"
import { ExecutionOwner } from "./execution-owner"
import { SessionExecution } from "./execution"
import { SessionProjector } from "./projector"
import { SessionRecovery } from "./recovery"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import { SessionTable } from "./sql"
import { eq } from "drizzle-orm"
import type { ProviderMetadata } from "@ranex/llm"

/**
 * The recovery critical section owns both fences. The Session owner excludes a
 * live process; EventV2's CAS claim is the durable writer fence for its one
 * possible recovery event. Any uncertainty stops recovery rather than replaying
 * a provider request or a side-effecting tool.
 */
export const recover = Effect.fn("Session.recover")(function* (input: {
  readonly events: EventV2.Interface
  readonly store: SessionStore.Interface
  readonly sessionID: SessionSchema.ID
  readonly wake?: (sessionID: SessionSchema.ID, force?: boolean) => Effect.Effect<void>
}) {
  const flock = yield* EffectFlock.Service
  const { db } = yield* Database.Service
  yield* flock.withLock(input.sessionID)(
    Effect.gen(function* () {
      const claimed = yield* input.store.claimExecution(input.sessionID, ExecutionOwner.ownerID)
      if (!claimed) {
        yield* Effect.logDebug("Session recovery skipped: execution ownership was not acquired").pipe(
          Effect.annotateLogs({ sessionID: input.sessionID }),
        )
        return
      }
      yield* Effect.gen(function* () {
        const previousEventOwner = yield* input.events.owner(input.sessionID)
        if (previousEventOwner && (yield* Effect.promise(() => ExecutionOwner.isLive(previousEventOwner)))) {
          yield* Effect.logWarning("Session recovery skipped: durable event owner may still be live").pipe(
            Effect.annotateLogs({ sessionID: input.sessionID }),
          )
          return
        }
        const eventClaimed = yield* input.events.claimConditional(
          input.sessionID,
          ExecutionOwner.ownerID,
          previousEventOwner,
        )
        if (!eventClaimed) {
          yield* Effect.logWarning("Session recovery skipped: durable event writer claim was not acquired").pipe(
            Effect.annotateLogs({ sessionID: input.sessionID }),
          )
          return
        }
        const row = yield* db
          .select({ retryAttempt: SessionTable.retry_attempt, retryNextAttemptAt: SessionTable.retry_next_attempt_at })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* Effect.die(`Session not found: ${input.sessionID}`)
        const decision = SessionRecovery.classify({
          messages: yield* input.store.context(input.sessionID),
          retry:
            row.retryAttempt === null || row.retryNextAttemptAt === null
              ? undefined
              : { attempt: row.retryAttempt, nextAttemptAt: row.retryNextAttemptAt },
          blockers: yield* input.store.blockers(input.sessionID),
        })
        if (decision._tag === "Idle") return
        if (decision._tag === "InterruptAmbiguousTool") {
          const blocker = {
            id: `recovery:${input.sessionID}:tool_side_effect_ambiguous:${decision.assistantMessageID}:${decision.callID}`,
            sessionID: input.sessionID,
            kind: "tool_side_effect_ambiguous" as const,
            assistantMessageID: decision.assistantMessageID,
            callID: decision.callID,
            aggregateSeq: yield* EventV2.latestSequence(db, input.sessionID),
          }
          yield* interruptTool(input.events, {
            sessionID: input.sessionID,
            assistantMessageID: decision.assistantMessageID,
            callID: decision.callID,
            provider: decision.provider,
            options: {
              ownerID: ExecutionOwner.ownerID,
              requireOwner: true,
              // Event publication and its ambiguity marker must commit together.
              commit: () => input.store.block(blocker),
            },
          })
          return
        }
        if (decision._tag === "BlockAmbiguousProvider") {
          yield* input.store.block({
            id: `recovery:${input.sessionID}:provider_in_flight:${decision.assistantMessageID}`,
            sessionID: input.sessionID,
            kind: "provider_in_flight",
            assistantMessageID: decision.assistantMessageID,
            aggregateSeq: yield* EventV2.latestSequence(db, input.sessionID),
          })
          return
        }
        if (decision._tag === "WaitForRetry") {
          // Wake the coordinator now; SessionRunner owns the durable backoff and
          // sleeps until nextAttemptAt before it constructs another provider turn.
          if (input.wake) yield* input.wake(input.sessionID)
          return
        }
        if (input.wake) yield* input.wake(input.sessionID, true)
      }).pipe(
        Effect.ensuring(input.events.release(input.sessionID, ExecutionOwner.ownerID)),
        Effect.ensuring(input.store.releaseExecution(input.sessionID, ExecutionOwner.ownerID)),
      )
    }),
  )
})

/** Compatibility entry point for the existing in-process runner reconciler. */
export const reconcileInterruptedTools = Effect.fn("Session.reconcileInterruptedTools")(function* (input: {
  readonly events: EventV2.Interface
  readonly store: SessionStore.Interface
  readonly sessionID: SessionSchema.ID
}) {
  const messages = yield* input.store.context(input.sessionID)
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const tool of message.content) {
      if (tool.type !== "tool" || tool.state.status !== "running") continue
      yield* Effect.yieldNow
      yield* interruptTool(input.events, {
        sessionID: input.sessionID,
        assistantMessageID: message.id,
        callID: tool.id,
        provider: {
          executed: tool.provider?.executed === true,
          ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
        },
      })
    }
  }
})

const interruptTool = (
  events: EventV2.Interface,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly assistantMessageID: import("./message").SessionMessage.ID
    readonly callID: string
    readonly provider: { readonly executed: boolean; readonly metadata?: ProviderMetadata }
    readonly options?: EventV2.PublishOptions
  },
) =>
  Effect.gen(function* () {
    yield* events.publish(
      SessionEvent.Tool.Failed,
      {
        sessionID: input.sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID: input.assistantMessageID,
        callID: input.callID,
        error: { type: "unknown", message: "Tool execution interrupted" },
        provider: input.provider,
      },
      input.options,
    )
  })

const sweepLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const events = yield* EventV2.Service
    const execution = yield* SessionExecution.Service
    const listExit = yield* store.list().pipe(Effect.exit)
    if (Exit.isFailure(listExit)) {
      yield* Effect.logError("Session recovery sweep: failed to list sessions", listExit.cause)
      return
    }
    yield* Effect.forEach(
      listExit.value,
      (session) =>
        recover({ events, store, sessionID: session.id, wake: execution.wake }).pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Exit.isFailure(exit)
              ? Effect.logError("Session recovery sweep failed", exit.cause).pipe(
                  Effect.annotateLogs({ sessionID: session.id }),
                )
              : Effect.void,
          ),
        ),
      { discard: true },
    )
  }),
)

export const sweepNode = makeGlobalNode({
  name: "session-reconcile-sweep",
  layer: sweepLayer,
  deps: [
    Database.node,
    EventV2.node,
    SessionStore.node,
    SessionProjector.node,
    SessionExecution.node,
    EffectFlock.node,
  ],
})
