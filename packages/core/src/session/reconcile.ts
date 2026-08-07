export * as SessionReconcile from "./reconcile"

import { DateTime, Effect, Exit, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionProjector } from "./projector"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"

/**
 * Reconciles tools stranded `running` by a prior crash: publishes one durable
 * `Tool.Failed` for each still-pending/running tool in the session's projected
 * history. The projector commits the failure inside the publish transaction, so
 * once this returns the projected tool state already reflects the interruption.
 *
 * This is the single read-then-act critical section that both `SessionRunner.run`
 * (hoisted above the eligible-input guard) and the startup sweep call. The
 * `Effect.yieldNow` between read and publish marks the boundary the per-session
 * mutex in the runner exists to serialize: without it the synchronous SQLite
 * driver makes the section accidentally atomic and the mutex untestable. Services
 * are passed in (not yielded) so the runner can bind them from its own scope and
 * keep the capability's requirement type closed.
 */
export const reconcileInterruptedTools = Effect.fn("Session.reconcileInterruptedTools")(function* (input: {
  readonly events: EventV2.Interface
  readonly store: SessionStore.Interface
  readonly sessionID: SessionSchema.ID
}) {
  const messages = yield* input.store.context(input.sessionID)
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const tool of message.content) {
      if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
      // The yield marks the read-then-act boundary the per-session mutex
      // serializes: it fires only when a stranded tool is about to be failed, so
      // a run() over a clean session is unaffected. Without it the synchronous
      // SQLite driver makes the section accidentally atomic and the mutex
      // untestable.
      yield* Effect.yieldNow
      yield* input.events.publish(SessionEvent.Tool.Failed, {
        sessionID: input.sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID: message.id,
        callID: tool.id,
        error: { type: "unknown", message: "Tool execution interrupted" },
        provider: {
          executed: tool.provider?.executed === true,
          ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
        },
      })
    }
  }
})

/**
 * Startup sweep: reconcile interrupted tools across every session at process
 * boot. This is the half the prototype left unwired — a `reconcile` capability
 * nobody called. A crash with an empty inbox never re-enters `run()` through the
 * inbox, so without this sweep those tools stay projected `running` forever.
 *
 * The sweep runs once when the application graph is built (before the server
 * accepts work), so it cannot race with a `run()` in THIS process and needs no
 * mutex. Each session is error-isolated: one bad session never aborts the sweep.
 *
 * UNSAFE UNDER CONCURRENT PROCESSES, and this is not theoretical. The sweep is
 * DB-global — `store.list()` returns every session in a database that is shared
 * process-wide (`database.ts`) — so a second process booting will mark tools that
 * a first, live process is actively running as interrupted. SLICE-011 claim 5
 * reproduced exactly that two-process double-drain before refusing it, so the
 * precondition is demonstrated rather than assumed.
 *
 * It is shipped anyway because the harness runs one daemon in normal operation
 * (ADR-014: one process, many tasks) and because closing it properly means a
 * durable owner claim — the fencing work ADR-015 defers to a later slice. A
 * reviewer raised this as a blocker; it was accepted as scope, not dismissed.
 * The fencing slice MUST gate this sweep on ownership before this harness is
 * run as more than one process against one database.
 */
const sweepLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const events = yield* EventV2.Service
    // List-level isolation: a malformed legacy row throws inside fromRow and must
    // not abort server boot. Per-session isolation then keeps one bad session
    // from aborting the rest.
    const listExit = yield* store.list().pipe(Effect.exit)
    if (Exit.isFailure(listExit)) {
      yield* Effect.logError("Session reconcile sweep: failed to list sessions", listExit.cause)
      return
    }
    yield* Effect.forEach(listExit.value, (session) =>
      Effect.gen(function* () {
        const exit = yield* reconcileInterruptedTools({ events, store, sessionID: session.id }).pipe(Effect.exit)
        if (Exit.isFailure(exit)) {
          yield* Effect.logError("Session reconcile sweep failed", exit.cause).pipe(
            Effect.annotateLogs({ sessionID: session.id }),
          )
        }
      }),
      { discard: true },
    )
  }),
)

export const sweepNode = makeGlobalNode({
  name: "session-reconcile-sweep",
  layer: sweepLayer,
  deps: [EventV2.node, SessionStore.node, SessionProjector.node],
})
