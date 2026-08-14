import { describe, expect, test } from "bun:test"
import { Cause, Console, Context, Effect, Exit, Fiber, Layer, Option, RcMap } from "effect"
import { ApplicationTools } from "@ranex/core/tool/application-tools"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { Database } from "@ranex/core/database/database"
import { EventV2 } from "@ranex/core/event"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { AbsolutePath } from "@ranex/core/schema"
import { Location } from "@ranex/core/location"
import { LocationLifecycle } from "@ranex/core/location-lifecycle"
import { buildLocationServiceMap, LocationServiceMap } from "@ranex/core/location-services"
import { tmpdir } from "./fixture/tmpdir"

const location = Location.Ref.make({ directory: AbsolutePath.make("/tmp/location-lifecycle-census") })
const silentConsole = new Proxy({}, { get: () => () => {} }) as Console.Console

class CapturedLifecycle extends Context.Service<
  CapturedLifecycle,
  { readonly lifecycle: Option.Option<LocationLifecycle.Interface> }
>()("@opencode/test/CapturedLifecycle") {}

function realGraph(onGenerationClosed: (inspection: LocationLifecycle.ClosedInspection) => void) {
  return AppNodeBuilder.build(
    LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node]),
    [[LocationServiceMap.node, buildLocationServiceMap([], { idleTimeToLive: "50 millis", onGenerationClosed })]],
  )
}

function waitForClosed(inspections: LocationLifecycle.ClosedInspection[], count: number): Effect.Effect<void> {
  if (inspections.length >= count) return Effect.void
  return Effect.sleep("10 millis").pipe(Effect.andThen(Effect.suspend(() => waitForClosed(inspections, count))))
}

describe("LocationLifecycle", () => {
  test("closes a zero census for fifty independent generations", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        for (let index = 0; index < 50; index++) {
          const lifecycle = yield* LocationLifecycle.make({ location, locationKey: "census-test" })
          const unregister = yield* lifecycle.register("fiber", "watcher")
          expect((yield* lifecycle.inspect()).counts.fiber).toBe(1)
          yield* unregister
          yield* lifecycle.close()
          expect((yield* lifecycle.inspect())).toMatchObject({
            generationID: lifecycle.generationID,
            state: "closed",
            counts: { fiber: 0, event_consumer: 0, listener: 0, subscription: 0 },
          })
        }
      }),
    )
  })

  test("rejects registration after a generation starts closing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* LocationLifecycle.make({ location, locationKey: "closing-test" })
        yield* lifecycle.close()
        const error = yield* lifecycle.register("fiber", "watcher").pipe(Effect.flip)
        expect(error).toMatchObject({
          _tag: "LocationLifecycle.RegistrationClosed",
          generationID: lifecycle.generationID,
        })
      }),
    )
  })

  test("reports the escaping owner in its teardown defect", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* LocationLifecycle.make({ location, locationKey: "defect-test" })
        yield* lifecycle.register("event_consumer", "models-dev-refresh")
        return yield* Effect.exit(lifecycle.close())
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(Cause.squash(exit.cause)).toMatchObject({
      name: "LocationLifecycle.IncompleteTeardown",
      countsByKind: { event_consumer: 1 },
      owners: ["models-dev-refresh"],
    })
  })

  test("finalizes graph resources before the lifecycle assertion", async () => {
    const order: string[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.void.pipe(
          Effect.provide(
            Layer.effectDiscard(
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() => Effect.sync(() => order.push("graph")))
              }),
            ).pipe(
              Layer.provide(
                Layer.effect(
                  LocationLifecycle.Service,
                  Effect.gen(function* () {
                    const lifecycle = yield* LocationLifecycle.make({ location, locationKey: "order-test" })
                    yield* Effect.addFinalizer(() =>
                      Effect.sync(() => order.push("lifecycle")).pipe(Effect.andThen(lifecycle.close())),
                    )
                    return lifecycle
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    )
    expect(order).toEqual(["graph", "lifecycle"])
  })

  test("uses a lifecycle captured during layer build from caller context", async () => {
    const captured = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const captured = yield* CapturedLifecycle
          if (Option.isNone(captured.lifecycle)) return yield* Effect.die("Expected captured lifecycle")
          const registration = yield* LocationLifecycle.registerCaptured(captured.lifecycle, "fiber", "reference-refresh")
          expect(registration._tag).toBe("tracked")
          if (registration._tag !== "tracked") return yield* Effect.die("Expected tracked registration")
          expect((yield* captured.lifecycle.value.inspect()).counts.fiber).toBe(1)
          yield* registration.unregister
          return captured.lifecycle
        }).pipe(
          Effect.provide(
            Layer.effect(
              CapturedLifecycle,
              Effect.map(LocationLifecycle.capture(), (lifecycle) => CapturedLifecycle.of({ lifecycle })),
            ).pipe(
              Layer.provide(LocationLifecycle.layer({ location, locationKey: "captured-test" })),
            ),
          ),
        ),
      ),
    )
    const registration = await Effect.runPromise(
      LocationLifecycle.registerCaptured(captured, "fiber", "reference-refresh"),
    )
    expect(registration).toMatchObject({ _tag: "closed" })
  })

  test(
    "reports a zero census for every expired real location generation",
    () => {
      const closed: LocationLifecycle.ClosedInspection[] = []
      return Effect.runPromise(
        Effect.scoped(
          Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
          ).pipe(
            Effect.flatMap((directory) =>
              Effect.gen(function* () {
                const locations = yield* LocationServiceMap.Service
                const ref = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
                for (let index = 0; index < 50; index++) {
                  yield* Location.Service.pipe(Effect.provide(locations.get(ref)), Effect.scoped)
                  yield* Effect.sleep("60 millis")
                  expect(yield* RcMap.has(locations.rcMap, ref)).toBe(false)
                  yield* waitForClosed(closed, index + 1)
                  expect(closed).toHaveLength(index + 1)
                  expect(closed[index]).toMatchObject({
                    state: "closed",
                    counts: { fiber: 0, event_consumer: 0, listener: 0, subscription: 0 },
                  })
                }
                expect(new Set(closed.map((inspection) => inspection.generationID)).size).toBe(50)
              }),
            ),
          ),
        ).pipe(Effect.provide(realGraph((inspection) => closed.push(inspection))), Effect.provideService(Console.Console, silentConsole)),
      )
    },
    30_000,
  )

  test(
    "keeps reacquisition at the expiry boundary in fresh generations",
    () => {
      const closed: LocationLifecycle.ClosedInspection[] = []
      return Effect.runPromise(
        Effect.scoped(
          Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
          ).pipe(
            Effect.flatMap((directory) =>
              Effect.gen(function* () {
                const locations = yield* LocationServiceMap.Service
                const ref = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
                for (let index = 0; index < 5; index++) {
                  yield* Location.Service.pipe(Effect.provide(locations.get(ref)), Effect.scoped)
                  yield* Effect.sleep("50 millis")
                  const racing = yield* Location.Service.pipe(
                    Effect.provide(locations.get(ref)),
                    Effect.scoped,
                    Effect.forkScoped,
                  )
                  yield* Fiber.join(racing)
                  yield* Effect.sleep("60 millis")
                  expect(yield* RcMap.has(locations.rcMap, ref)).toBe(false)
                  expect(closed.every((inspection) => inspection.state === "closed")).toBe(true)
                  expect(
                    closed.every((inspection) =>
                      Object.values(inspection.counts).every((count) => count === 0),
                    ),
                  ).toBe(true)
                }
                yield* waitForClosed(closed, 5)
                expect(new Set(closed.map((inspection) => inspection.generationID)).size).toBe(closed.length)
              }),
            ),
          ),
        ).pipe(Effect.provide(realGraph((inspection) => closed.push(inspection))), Effect.provideService(Console.Console, silentConsole)),
      )
    },
    15_000,
  )
})
