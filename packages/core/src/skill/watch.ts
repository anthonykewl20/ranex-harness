export * as SkillWatch from "./watch"

import { Cause, Context, Effect, Exit, FiberHandle, Layer, Schedule, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { truthy } from "../flag/flag"
import { Watcher } from "../filesystem/watcher"
import { SkillV2 } from "../skill"

// Filesystem events under a skill source trigger a debounced refresh so write
// bursts coalesce into a single re-read. Skill sources register asynchronously
// (config plugins boot in a fork) and their set can change on later config
// reloads, so subscriptions are also synced on a slow schedule; a directory
// that could not be subscribed yet (it may not exist yet) is retried there.
// When watching is unavailable entirely (no native binding, or disabled via
// RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER), events never arrive, so that same
// schedule degrades to interval-based skill revalidation.
const REFRESH_DEBOUNCE = "1 second"
const RESYNC_INTERVAL = "10 seconds"

export interface Interface {
  /**
   * Reconciles subscriptions with current skill sources; testable entry point.
   * When watching is unavailable for a directory, also refreshes skills so
   * edits stay visible on the resync interval instead of never.
   */
  readonly sync: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SkillWatch") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* SkillV2.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const pending = yield* FiberHandle.make()
    const subscriptions = new Map<string, Effect.Effect<void>>()
    const unwatched = new Set<string>()
    const warned = new Set<string>()

    const sync = Effect.fn("SkillWatch.sync")(function* () {
      const wanted: Set<string> = new Set(
        (yield* skills.sources()).flatMap((source) => (source.type === "directory" ? [source.path] : [])),
      )
      let added = false
      for (const [directory, close] of subscriptions) {
        if (wanted.has(directory)) continue
        subscriptions.delete(directory)
        unwatched.delete(directory)
        yield* close.pipe(Effect.ignore)
      }
      for (const directory of wanted) {
        if (subscriptions.has(directory)) continue
        const entryScope = yield* Scope.make()
        const subscribed = yield* Watcher.watchDirectory(directory, trigger).pipe(
          Scope.provide(entryScope),
          Effect.catchCause((cause) =>
            Effect.logError("failed to watch skill directory", { directory, cause: Cause.pretty(cause) }).pipe(
              Effect.as(false),
            ),
          ),
        )
        if (!subscribed) {
          // Only the unavailable case is a dead end (events can never
          // arrive); transient failures (a source directory that does not
          // exist yet) are retried on the next sync. Availability is read
          // per call — the same seam subscribeParcel uses — so a disable
          // flag set after this layer was built still degrades to
          // interval-based refresh instead of being misclassified as
          // transient.
          if (Watcher.hasNativeBinding() && !truthy("RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER")) continue
          unwatched.add(directory)
          // Warn once per directory — not on every 10s retry cycle.
          if (warned.has(directory)) continue
          warned.add(directory)
          yield* Effect.logWarning("cannot watch skill directory; skill edits refresh only on the resync interval", {
            directory,
            resyncInterval: RESYNC_INTERVAL,
          })
          continue
        }
        unwatched.delete(directory)
        subscriptions.set(directory, Scope.close(entryScope, Exit.void))
        added = true
      }
      // A newly watched directory may have changed while unwatched (boot
      // registers sources after this layer starts), so schedule a refresh.
      if (added) trigger()
      // Watching is unavailable for some directories, so events will never
      // arrive: degrade to interval-based revalidation (the repeating resync
      // schedule below drives this same sync). Watched directories keep
      // their event-driven behavior.
      if (unwatched.size > 0) {
        yield* skills.refresh().pipe(
          Effect.catchCause((cause) => Effect.logError("skill refresh failed", { cause: Cause.pretty(cause) })),
        )
      }
    })

    const flush = Effect.gen(function* () {
      yield* skills.refresh().pipe(
        Effect.catchCause((cause) => Effect.logError("skill refresh failed", { cause: Cause.pretty(cause) })),
      )
      yield* sync()
    })

    // Explicitly typed: sync's subscription callbacks reference this before
    // its initializer runs, and the annotation breaks the inference cycle.
    const trigger: () => void = () =>
      runFork(FiberHandle.run(pending, Effect.sleep(REFRESH_DEBOUNCE).pipe(Effect.andThen(flush))))

    yield* Effect.addFinalizer(() =>
      Effect.forEach(subscriptions.values(), (close) => close.pipe(Effect.ignore), { discard: true }),
    )
    yield* sync()
    yield* sync().pipe(
      Effect.repeat(Schedule.spaced(RESYNC_INTERVAL)),
      Effect.catchCause((cause) => Effect.logError("skill watch sync failed", { cause: Cause.pretty(cause) })),
      Effect.forkScoped,
    )
    return Service.of({ sync })
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("failed to init skill watcher", { cause: Cause.pretty(cause) }).pipe(
        Effect.as(Service.of({ sync: () => Effect.void })),
      )
    ),
  ),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillV2.node] })
