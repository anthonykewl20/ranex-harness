import { Database } from "@ranex/core/database/database"
import { makeGlobalNode } from "@ranex/core/effect/app-node"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Global } from "@ranex/core/global"
import { LocationServiceMap } from "@ranex/core/location-service-map"
import { SessionV2 } from "@ranex/core/session"
import { SessionExecution } from "@ranex/core/session/execution"
import { SessionExecutionLocal } from "@ranex/core/session/execution/local"
import { ExecutionOwner } from "@ranex/core/session/execution-owner"
import { SessionRunner } from "@ranex/core/session/runner"
import { SessionStore } from "@ranex/core/session/store"
import type { LocationError, LocationServices } from "@ranex/core/location-services"
import { Effect, Layer, LayerMap } from "effect"
import { appendFile } from "node:fs/promises"

const input = JSON.parse(process.argv[2] ?? "") as {
  mode: "fenced" | "unfenced" | "claim"
  dbFile: string
  state: string
  sessionID: string
  logFile: string
  readyFile: string
  releaseFile?: string
  startFile?: string
  hold: number
}

const runner = SessionRunner.Service.of({
  run: () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => Bun.write(input.readyFile, ExecutionOwner.ownerID))
      if (input.startFile)
        while (!(yield* Effect.promise(() => Bun.file(input.startFile!).exists()))) yield* Effect.sleep("10 millis")
      if (yield* Effect.promise(() => Bun.file(input.logFile).exists())) return
      yield* Effect.sleep(`${input.hold} millis`)
      yield* Effect.promise(() => appendFile(input.logFile, `${ExecutionOwner.ownerID}\n`))
    }),
  reconcile: () => Effect.void,
})
const locations = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    LayerMap.make(
      () => Layer.succeed(SessionRunner.Service, runner) as Layer.Layer<LocationServices, LocationError>,
      { idleTimeToLive: "1 minute" },
    ),
  ),
  deps: [],
})
const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, SessionStore.node, SessionExecutionLocal.node]),
  [
    [Database.node, Database.layerFromPath(input.dbFile)],
    [Global.node, Global.layerWith({ state: input.state })],
    [LocationServiceMap.node, locations],
  ],
)

await Effect.runPromise(
  Effect.gen(function* () {
    const sessionID = SessionV2.ID.make(input.sessionID)
    if (input.mode === "claim") {
      const store = yield* SessionStore.Service
      const claimed = yield* store.claimExecution(sessionID, ExecutionOwner.ownerID)
      if (!claimed) return
      yield* Effect.promise(() => Bun.write(input.readyFile, ExecutionOwner.ownerID))
      if (input.releaseFile) {
        while (!(yield* Effect.promise(() => Bun.file(input.releaseFile!).exists()))) yield* Effect.sleep("10 millis")
        return
      }
      yield* Effect.sleep(`${input.hold} millis`)
      return
    }
    if (input.mode === "unfenced") {
      yield* Effect.promise(() => Bun.write(input.readyFile, ExecutionOwner.ownerID))
      if (input.startFile)
        while (!(yield* Effect.promise(() => Bun.file(input.startFile!).exists()))) yield* Effect.sleep("10 millis")
      yield* Effect.sleep(`${input.hold} millis`)
      yield* Effect.promise(() => appendFile(input.logFile, `${ExecutionOwner.ownerID}\n`))
      return
    }
    const execution = yield* SessionExecution.Service
    yield* execution.resume(sessionID)
  }).pipe(Effect.scoped, Effect.provide(layer)),
).catch((error) => {
  process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
})
