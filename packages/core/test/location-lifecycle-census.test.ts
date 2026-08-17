import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { Cause, ConfigProvider, Console, Context, Deferred, Effect, Exit, Fiber, Layer, Option, RcMap, Stream } from "effect"
import { ApplicationTools } from "@ranex/core/tool/application-tools"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { Database } from "@ranex/core/database/database"
import { EventV2 } from "@ranex/core/event"
import { Watcher } from "@ranex/core/filesystem/watcher"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { AbsolutePath } from "@ranex/core/schema"
import { Location } from "@ranex/core/location"
import { LocationLifecycle } from "@ranex/core/location-lifecycle"
import { buildLocationServiceMap, LocationServiceMap } from "@ranex/core/location-services"
import { Project } from "@ranex/core/project"
import { ProjectResolution } from "@ranex/core/project-resolution"
import { tmpdir } from "./fixture/tmpdir"

const location = Location.Ref.make({ directory: AbsolutePath.make("/tmp/location-lifecycle-census") })
const silentConsole = new Proxy({}, { get: () => () => {} }) as Console.Console
// Location generations build lazily inside the LayerMap at acquisition time,
// so a build-time ConfigProvider layer around the graph never reaches them;
// the watcher flag has to ride the runtime context instead.
const watcherFlags = ConfigProvider.fromUnknown({
  RANEX_EXPERIMENTAL_FILEWATCHER: "true",
  RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
})

class CapturedLifecycle extends Context.Service<
  CapturedLifecycle,
  { readonly lifecycle: Option.Option<LocationLifecycle.Interface> }
>()("@opencode/test/CapturedLifecycle") {}

function realGraph(
  onGenerationClosed: (inspection: LocationLifecycle.ClosedInspection) => void,
  replacements: LayerNode.Replacements = [],
) {
  return AppNodeBuilder.build(
    LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node]),
    [[LocationServiceMap.node, buildLocationServiceMap(replacements, { idleTimeToLive: "50 millis", onGenerationClosed })]],
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

  test("interrupts and unregisters a scoped vcs warm-up when its generation expires", async () => {
    await using directory = await tmpdir()
    const warmupLocation = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
    const closed: LocationLifecycle.ClosedInspection[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        const projectLayer = Layer.succeed(
          Project.Service,
          Project.Service.of({
            directories: () => Effect.succeed([]),
            resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
            resolveStrict: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              ),
            commit: () => Effect.void,
          }),
        )
        yield* Effect.gen(function* () {
          const locations = yield* LocationServiceMap.Service
          const resolution = yield* ProjectResolution.Service.pipe(
            Effect.provide(locations.get(warmupLocation)),
            Effect.scoped,
          )
          yield* Deferred.await(started)
          expect(yield* resolution.status()).toEqual({ status: "loading" })
          yield* Effect.sleep("60 millis")
          yield* Deferred.await(interrupted)
          expect(yield* RcMap.has(locations.rcMap, warmupLocation)).toBe(false)
          yield* waitForClosed(closed, 1)
          expect(closed[0]).toMatchObject({
            state: "closed",
            counts: { fiber: 0, event_consumer: 0, listener: 0, subscription: 0 },
          })
          expect(closed[0]?.owners).not.toContain("vcs-warmup")
        }).pipe(
          Effect.provide(realGraph((inspection) => closed.push(inspection), [[Project.node, projectLayer]])),
          Effect.provideService(Console.Console, silentConsole),
        )
      }),
    )
  })

  test("resolves a non-repository location globally and closes its expired generation with a zero census", async () => {
    await using directory = await tmpdir()
    expect(await Bun.file(`${directory.path}/.git`).exists()).toBe(false)
    const closed: LocationLifecycle.ClosedInspection[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        const ref = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
        const ready = yield* Effect.gen(function* () {
          const resolution = yield* ProjectResolution.Service
          return yield* resolution.awaitReady()
        }).pipe(Effect.provide(locations.get(ref)), Effect.scoped)
        expect(ready.project).toMatchObject({ id: Project.ID.global })
        yield* Effect.sleep("60 millis")
        expect(yield* RcMap.has(locations.rcMap, ref)).toBe(false)
        yield* waitForClosed(closed, 1)
        expect(closed[0]).toMatchObject({
          state: "closed",
          counts: { fiber: 0, event_consumer: 0, listener: 0, subscription: 0 },
        })
      }).pipe(
        Effect.provide(realGraph((inspection) => closed.push(inspection))),
        Effect.provideService(Console.Console, silentConsole),
      ),
    )
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

  test.skipIf(!Watcher.hasNativeBinding() || !!process.env.CI)(
    "expires a git location generation with an active watcher subscription at a zero census",
    () => {
      const closed: LocationLifecycle.ClosedInspection[] = []
      return Effect.runPromise(
        Effect.scoped(
          Effect.acquireRelease(
            Effect.promise(async () => {
              const tmp = await tmpdir()
              await $`git init`.cwd(tmp.path).quiet()
              await $`git config core.fsmonitor false`.cwd(tmp.path).quiet()
              await $`git config commit.gpgsign false`.cwd(tmp.path).quiet()
              await $`git config user.email test@opencode.test`.cwd(tmp.path).quiet()
              await $`git config user.name Test`.cwd(tmp.path).quiet()
              await $`git commit --allow-empty -m root`.cwd(tmp.path).quiet()
              return tmp
            }),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          ).pipe(
            Effect.flatMap((tmp) =>
              Effect.gen(function* () {
                const locations = yield* LocationServiceMap.Service
                const ref = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
                // Hold the generation until the watcher's root subscription is
                // live — its "subscription" census entry must exist before
                // expiry, or the teardown regression under test cannot
                // reproduce. The parcel subscription attaches asynchronously,
                // so keep writing fresh probe files until one update lands.
                yield* Effect.gen(function* () {
                  const events = yield* EventV2.Service
                  const updated = yield* Deferred.make<void>()
                  const fiber = yield* events.subscribe(Watcher.Event.Updated).pipe(
                    Stream.runForEach((event) =>
                      event.data.file.startsWith(`${tmp.path}/.census-probe`)
                        ? Deferred.succeed(updated, undefined)
                        : Effect.void,
                    ),
                    Effect.forkScoped,
                  )
                  yield* Effect.yieldNow
                  let live = false
                  for (let attempt = 0; attempt < 40; attempt++) {
                    yield* Effect.promise(() => Bun.write(`${tmp.path}/.census-probe-${attempt}`, "probe"))
                    const seen = yield* Deferred.await(updated).pipe(Effect.timeoutOption("250 millis"))
                    if (Option.isSome(seen)) {
                      live = true
                      break
                    }
                  }
                  yield* Fiber.interrupt(fiber)
                  expect(live).toBe(true)
                  // The census registration lands in the same fork, right
                  // after the parcel subscription resolves; let it settle.
                  yield* Effect.sleep("50 millis")
                }).pipe(Effect.provide(locations.get(ref)), Effect.scoped)
                yield* Effect.sleep("60 millis")
                expect(yield* RcMap.has(locations.rcMap, ref)).toBe(false)
                yield* waitForClosed(closed, 1).pipe(
                  Effect.timeoutOrElse({
                    duration: "10 seconds",
                    orElse: () => Effect.die("generation did not close with a zero census (leaked registration)"),
                  }),
                )
                expect(closed[0]).toMatchObject({
                  state: "closed",
                  counts: { fiber: 0, event_consumer: 0, listener: 0, subscription: 0 },
                })
              }),
            ),
          ).pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, watcherFlags),
            Effect.provide(realGraph((inspection) => closed.push(inspection))),
          ),
        ),
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
