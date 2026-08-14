export * as Watcher from "./watcher"

// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { makeLocationNode } from "../effect/app-node"
import { Cause, Context, Effect, Fiber, Layer, Scope } from "effect"
import { FileSystemWatcher } from "@ranex/schema/filesystem-watcher"
import path from "path"
import { Config } from "../config"
import { EventV2 } from "../event"
import { Flag } from "../flag/flag"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationLifecycle } from "../location-lifecycle"
import { ProjectResolution } from "../project-resolution"
import { lazy } from "../util/lazy"
import { Ignore } from "./ignore"
import { Protected } from "./protected"

declare const RANEX_LIBC: string | undefined

const SUBSCRIBE_TIMEOUT_MS = 10_000

export const Event = FileSystemWatcher.Event

const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const libc = typeof RANEX_LIBC === "undefined" ? undefined : RANEX_LIBC
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch {
    return
  }
})

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const relative = path.relative(dir, item)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  })
}

export const hasNativeBinding = () => !!watcher()

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileWatcher") {}

interface Subscription {
  readonly subscription: ParcelWatcher.AsyncSubscription
  readonly deactivate: () => void
  readonly unregister: Effect.Effect<void> | undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (yield* Flag.RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER) return Service.of({})

    const backend = getBackend()
    const location = yield* Location.Service
    if (!backend) {
      yield* Effect.logError("watcher backend not supported", {
        directory: location.directory,
        platform: process.platform,
      })
      return Service.of({})
    }

    const w = watcher()
    if (!w) return Service.of({})

    yield* Effect.logInfo("watcher backend", { directory: location.directory, platform: process.platform, backend })
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const resolution = yield* ProjectResolution.Service
    const scope = yield* Scope.Scope
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const subscriptions = new Set<Subscription>()
    yield* Effect.addFinalizer(() =>
      Effect.forEach(subscriptions, ({ subscription, deactivate, unregister }) =>
        Effect.sync(deactivate).pipe(
          Effect.andThen(Effect.promise(() => subscription.unsubscribe())),
          Effect.ignore,
          Effect.ensuring(unregister ?? Effect.void),
        ),
      ).pipe(Effect.asVoid),
    )

    const callback: ParcelWatcher.SubscribeCallback = (_error, updates) => {
      for (const update of updates) {
        if (update.type === "create") runFork(events.publish(Event.Updated, { file: update.path, event: "add" }))
        if (update.type === "update") runFork(events.publish(Event.Updated, { file: update.path, event: "change" }))
        if (update.type === "delete") runFork(events.publish(Event.Updated, { file: update.path, event: "unlink" }))
      }
    }

    const subscribe = (directory: string, ignore: string[]) => {
      let active = true
      const pending = w.subscribe(directory, (error, updates) => {
        if (active) callback(error, updates)
      }, { ignore, backend })
      return Effect.promise(() => pending).pipe(
        Effect.map((subscription) => ({ subscription, deactivate: () => (active = false) })),
        Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
        Effect.catchCause((cause) => {
          pending.then((subscription) => subscription.unsubscribe()).catch(() => {})
          return Effect.logError("failed to subscribe", { directory, cause: Cause.pretty(cause) }).pipe(
            Effect.as(undefined),
          )
        }),
      )
    }

    const configService = yield* Config.Service
    const bootstrap = configService.bootstrapEntries
      ? yield* configService.bootstrapEntries()
      : yield* configService.entries()
    const config = bootstrap
      .filter((entry): entry is Config.Document => entry.type === "document")
      .flatMap((item) => item.info.watcher?.ignore ?? [])
    const status = yield* resolution.status()
    const experimental = yield* Flag.RANEX_EXPERIMENTAL_FILEWATCHER
    const rootStarted =
      experimental && (status.status === "loading" || (status.status === "ready" && !!status.value.project.vcs))
    const startSubscription = Effect.fnUntraced(function* (
      directory: string,
      ignore: string[],
      onSubscribed?: (subscription: Subscription) => void,
    ) {
      const fiberUnregister = yield* LocationLifecycle.registerOptional("fiber", "watcher")
      return yield* subscribe(directory, ignore)
        .pipe(
          Effect.flatMap((subscription) => {
            if (!subscription) return Effect.succeed(undefined)
            return LocationLifecycle.registerOptional("subscription", "watcher").pipe(
              Effect.map((unregister) => {
                const tracked = { ...subscription, unregister }
                subscriptions.add(tracked)
                onSubscribed?.(tracked)
                return tracked
              }),
            )
          }),
          Effect.ensuring(fiberUnregister ?? Effect.void),
          Effect.forkIn(scope, { startImmediately: true }),
        )
    })
    const stopSubscription = (tracked: Subscription) =>
      Effect.sync(tracked.deactivate).pipe(
        Effect.andThen(Effect.promise(() => tracked.subscription.unsubscribe())),
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => subscriptions.delete(tracked)).pipe(Effect.andThen(tracked.unregister ?? Effect.void)),
        ),
      )
    const root = { subscription: undefined as Subscription | undefined }
    const rootSubscription = rootStarted
      ? yield* startSubscription(
          location.directory,
          [
            ...Ignore.PATTERNS,
            ...config,
            ...protecteds(location.directory),
          ],
          (subscription) => (root.subscription = subscription),
        )
      : undefined

    yield* LocationLifecycle.track("fiber", "watcher")
    yield* Effect.gen(function* () {
      const ready = status.status === "ready" ? status.value : yield* resolution.awaitReady()
      const loaded = (yield* configService.entries())
        .filter((entry): entry is Config.Document => entry.type === "document")
        .flatMap((item) => item.info.watcher?.ignore ?? [])
      const rootIgnore = [...Ignore.PATTERNS, ...loaded, ...protecteds(location.directory)]
      if (rootSubscription) yield* Fiber.join(rootSubscription).pipe(Effect.ignore)
      const replacement = root.subscription
      const bootstrapIgnore = [...Ignore.PATTERNS, ...config, ...protecteds(location.directory)]
      const rootChanged =
        bootstrapIgnore.length !== rootIgnore.length || bootstrapIgnore.some((item, index) => item !== rootIgnore[index])
      if (replacement && (rootChanged || ready.project.vcs?.type !== "git")) {
        yield* stopSubscription(replacement)
      }
      if (ready.project.vcs?.type !== "git") {
        return
      }
      const resolved = ready.repository?.gitDirectory
      const vcs = resolved ? yield* fs.realPath(resolved).pipe(Effect.catch(() => Effect.succeed(resolved))) : undefined
      if (experimental && (!replacement || rootChanged)) yield* startSubscription(location.directory, rootIgnore)
      if (vcs && !loaded.includes(".git") && !loaded.includes(vcs) && (!resolved || !loaded.includes(resolved))) {
        const ignore = (yield* fs.readDirectoryEntries(vcs).pipe(Effect.catch(() => Effect.succeed([])))).flatMap(
          (entry) => (entry.name === "HEAD" ? [] : [entry.name]),
        )
        yield* startSubscription(vcs, ignore)
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("failed to resolve watcher repository", { cause })),
      Effect.forkIn(scope, { startImmediately: true }),
    )

    return Service.of({})
  }).pipe(
    Effect.catchCause((cause) => {
      return Effect.logError("failed to init watcher service", { cause: Cause.pretty(cause) }).pipe(
        Effect.as(Service.of({})),
      )
    }),
  ),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Location.node, Config.node, ProjectResolution.node, EventV2.node],
})
