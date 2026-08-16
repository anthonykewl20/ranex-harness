import { Database } from "@ranex/core/database/database"
import { LLMEvent } from "@ranex/llm"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { EventV2 } from "@ranex/core/event"
import { SessionV2 } from "@ranex/core/session"
import { ExecutionOwner } from "@ranex/core/session/execution-owner"
import { ModelV2 } from "@ranex/core/model"
import { ProviderV2 } from "@ranex/core/provider"
import { SessionProjector } from "@ranex/core/session/projector"
import { SessionReconcile } from "@ranex/core/session/reconcile"
import { createLLMEventPublisher } from "@ranex/core/session/runner/publish-llm-event"
import { SessionStore } from "@ranex/core/session/store"
import { SessionExecution } from "@ranex/core/session/execution"
import { Effect } from "effect"

function input() {
  const raw = process.argv[2]
  if (!raw) throw new Error("Missing reconcile fence worker input")
  const value: unknown = JSON.parse(raw)
  if (typeof value !== "object" || value === null) throw new Error("Invalid reconcile fence worker input")
  if (
    !("mode" in value) ||
    (value.mode !== "claim" && value.mode !== "claim-exit" && value.mode !== "strand" && value.mode !== "sweep")
  )
    throw new Error("Invalid reconcile fence worker mode")
  if (!("dbFile" in value) || typeof value.dbFile !== "string") throw new Error("Invalid database file")
  if (!("sessionID" in value) || typeof value.sessionID !== "string") throw new Error("Invalid session ID")
  if (!("readyFile" in value) || typeof value.readyFile !== "string") throw new Error("Invalid ready file")
  return {
    mode: value.mode,
    dbFile: value.dbFile,
    sessionID: value.sessionID,
    readyFile: value.readyFile,
  }
}

async function main() {
  const msg = input()
  if (msg.mode === "claim" || msg.mode === "claim-exit" || msg.mode === "strand") {
    const layer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node]), [
      [Database.node, Database.layerFromPath(msg.dbFile)],
    ])
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SessionStore.Service
        const sessionID = SessionV2.ID.make(msg.sessionID)
        const claimed = yield* store.claimExecution(sessionID, ExecutionOwner.ownerID)
        if (!claimed) return yield* Effect.die("Failed to claim Session execution ownership")
        if (msg.mode !== "strand") return
        const events = yield* EventV2.Service
        const publisher = createLLMEventPublisher(events, {
          sessionID,
          agent: "build",
          model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
        })
        yield* publisher.publish(LLMEvent.toolInputStart({ id: "call-stranded", name: "echo" }))
        yield* publisher.publish(LLMEvent.toolInputEnd({ id: "call-stranded", name: "echo" }))
        yield* publisher.publish(LLMEvent.toolCall({ id: "call-stranded", name: "echo", input: { text: "hi" } }))
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
    await Bun.write(msg.readyFile, String(process.pid))
    if (msg.mode === "claim-exit") process.exit(0)
    await new Promise<void>(() => {})
    return
  }

  const layer = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionExecution.node,
      SessionReconcile.sweepNode,
    ]),
    [[Database.node, Database.layerFromPath(msg.dbFile)], [SessionExecution.node, SessionExecution.noopLayer]],
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* SessionStore.Service
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )
}

await main().catch((error) => {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(text)
  process.exit(1)
})
