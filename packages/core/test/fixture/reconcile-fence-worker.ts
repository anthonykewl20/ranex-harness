import { Database } from "@ranex/core/database/database"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { EventV2 } from "@ranex/core/event"
import { SessionV2 } from "@ranex/core/session"
import { ExecutionOwner } from "@ranex/core/session/execution-owner"
import { SessionProjector } from "@ranex/core/session/projector"
import { SessionReconcile } from "@ranex/core/session/reconcile"
import { SessionStore } from "@ranex/core/session/store"
import { Effect } from "effect"

function input() {
  const raw = process.argv[2]
  if (!raw) throw new Error("Missing reconcile fence worker input")
  const value: unknown = JSON.parse(raw)
  if (typeof value !== "object" || value === null) throw new Error("Invalid reconcile fence worker input")
  if (!("mode" in value) || (value.mode !== "claim" && value.mode !== "claim-exit" && value.mode !== "sweep"))
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
  if (msg.mode === "claim" || msg.mode === "claim-exit") {
    const layer = AppNodeBuilder.build(LayerNode.group([Database.node, SessionStore.node]), [
      [Database.node, Database.layerFromPath(msg.dbFile)],
    ])
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* SessionStore.Service
        yield* store.claimExecution(SessionV2.ID.make(msg.sessionID), ExecutionOwner.ownerID)
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
    await Bun.write(msg.readyFile, String(process.pid))
    if (msg.mode === "claim-exit") process.exit(0)
    await new Promise<void>(() => {})
    return
  }

  const layer = AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionReconcile.sweepNode]),
    [[Database.node, Database.layerFromPath(msg.dbFile)]],
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
