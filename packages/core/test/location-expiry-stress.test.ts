import { describe, expect, test } from "bun:test"
import { Console, Deferred, Effect, Layer, RcMap } from "effect"
import { ApplicationTools } from "@ranex/core/tool/application-tools"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Database } from "@ranex/core/database/database"
import { EventV2 } from "@ranex/core/event"
import { Location } from "@ranex/core/location"
import { buildLocationServiceMap, LocationServiceMap } from "@ranex/core/location-services"
import { ModelsDev } from "@ranex/core/models-dev"
import { Node } from "@ranex/core/effect/app-node"
import { PluginInternal } from "@ranex/core/plugin/internal"
import { AbsolutePath } from "@ranex/core/schema"
import { tmpdir } from "./fixture/tmpdir"

const finalization = { closed: [] as Deferred.Deferred<void>[] }
const periodic = { active: 0, maximum: 0 }
const silentConsole = new Proxy({}, { get: () => () => {} }) as Console.Console

const finalizerPlugin = Node.makeLocationNode({
  name: PluginInternal.node.name,
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>()
      finalization.closed.push(closed)
      yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined))
    }),
  ),
  deps: [],
})

const layer = AppNodeBuilder.build(
  LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node]),
  [
    [PluginInternal.node, finalizerPlugin],
    [
      LocationServiceMap.node,
      buildLocationServiceMap([[PluginInternal.node, finalizerPlugin]], { idleTimeToLive: "50 millis" }),
    ],
  ],
)

const periodicModels = Node.makeGlobalNode({
  service: ModelsDev.Service,
  layer: Layer.effect(
    ModelsDev.Service,
    Effect.gen(function* () {
      periodic.active += 1
      periodic.maximum = Math.max(periodic.maximum, periodic.active)
      const closed = yield* Deferred.make<void>()
      finalization.closed.push(closed)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => (periodic.active -= 1)).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
      )
      yield* Effect.forkScoped(Effect.never)
      return ModelsDev.Service.of({ get: () => Effect.succeed({}), refresh: () => Effect.void })
    }),
  ),
  deps: [],
})
const periodicPlugin = Node.makeLocationNode({
  name: PluginInternal.node.name,
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      yield* ModelsDev.Service
    }),
  ),
  deps: [ModelsDev.node],
})
const periodicLayer = AppNodeBuilder.build(
  LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node]),
  [
    [ModelsDev.node, periodicModels],
    [PluginInternal.node, periodicPlugin],
    [
      LocationServiceMap.node,
      buildLocationServiceMap(
        [
          [ModelsDev.node, periodicModels],
          [PluginInternal.node, periodicPlugin],
        ],
        { idleTimeToLive: "50 millis" },
      ),
    ],
  ],
)

function snapshot() {
  Bun.gc(true)
  const getActiveHandles = (process as typeof process & { _getActiveHandles?: () => unknown[] })._getActiveHandles
  const memory = process.memoryUsage()
  return { rss: memory.rss, heapUsed: memory.heapUsed, handles: getActiveHandles?.().length }
}

function stress(cycles: number, maximumRssGrowth: number) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((directory) =>
      Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        const listenerBaseline = (yield* EventV2.Service).listenerCount()
        const ref = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
        const expired: boolean[] = []
        let baseline: ReturnType<typeof snapshot> | undefined
        finalization.closed.length = 0

        for (let index = 0; index < cycles; index++) {
          yield* Location.Service.pipe(Effect.provide(locations.get(ref)), Effect.scoped)
          yield* Effect.sleep("60 millis")
          expect(finalization.closed).toHaveLength(index + 1)
          yield* Deferred.await(finalization.closed[index]!).pipe(Effect.timeout("5 seconds"))
          expired.push(yield* RcMap.has(locations.rcMap, ref))
          expect((yield* EventV2.Service).listenerCount()).toBe(listenerBaseline)
          if (index === 19) {
            baseline = yield* Effect.sync(snapshot)
          }
        }

        const final = yield* Effect.sync(snapshot)
        expect(expired.every((entry) => !entry)).toBe(true)
        expect(baseline).toBeDefined()
        expect(final.rss - baseline!.rss).toBeLessThan(maximumRssGrowth)
        if (baseline!.handles !== undefined && final.handles !== undefined)
          expect(final.handles).toBeLessThanOrEqual(baseline!.handles + 4)
      }),
    ),
  )
}

describe("LocationServiceMap expiry stress", () => {
  test(
    "releases full location layers without retaining process resources",
    () =>
      Effect.runPromise(
        Effect.scoped(stress(180, 120 * 1024 * 1024)).pipe(
          Effect.provide(layer),
          Effect.provideService(Console.Console, silentConsole),
        ),
      ),
    60_000,
  )

  test.skip(
    "exposes RSS growth after 400 full location generations",
    () =>
      Effect.runPromise(
        Effect.scoped(stress(400, 64 * 1024 * 1024)).pipe(
          Effect.provide(layer),
          Effect.provideService(Console.Console, silentConsole),
        ),
      ),
    120_000,
  )

  test(
    "scoped periodic fiber does not accumulate across generations",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
          ).pipe(
            Effect.flatMap((directory) =>
              Effect.gen(function* () {
                periodic.active = 0
                periodic.maximum = 0
                finalization.closed.length = 0
                const locations = yield* LocationServiceMap.Service
                const ref = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })

                for (let index = 0; index < 20; index++) {
                  yield* Location.Service.pipe(Effect.provide(locations.get(ref)), Effect.scoped)
                  yield* Effect.sleep("60 millis")
                  expect(finalization.closed).toHaveLength(index + 1)
                  yield* Deferred.await(finalization.closed[index]!).pipe(Effect.timeout("5 seconds"))
                  expect(periodic.active).toBe(0)
                }

                expect(periodic.maximum).toBe(1)
              }),
            ),
          ),
        ).pipe(Effect.provide(periodicLayer), Effect.provideService(Console.Console, silentConsole)),
      ),
    15_000,
  )
})
