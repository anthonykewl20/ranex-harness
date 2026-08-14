export * as ProjectResolution from "./project-resolution"

import { Context, Deferred, Effect, Exit, Layer, Option, Ref, Schema, Scope } from "effect"
import { Config } from "./config"
import { ConfigProjectResolution } from "./config/project-resolution"
import { makeLocationNode } from "./effect/app-node"
import { Git } from "./git"
import { Location } from "./location"
import { LocationLifecycle } from "./location-lifecycle"
import { Project } from "./project"

export class TimedOutError extends Schema.TaggedErrorClass<TimedOutError>()("timed_out", {
  deadline_ms: Schema.Number,
}) {}

export class GitFailedError extends Schema.TaggedErrorClass<GitFailedError>()("git_failed", {
  cause: Schema.Defect(),
}) {}

export class FileSystemFailedError extends Schema.TaggedErrorClass<FileSystemFailedError>()("filesystem_failed", {
  cause: Schema.Defect(),
}) {}

export type Error = TimedOutError | GitFailedError | FileSystemFailedError

export interface Ready {
  readonly project: Project.Resolved
  readonly repository?: Git.Repository
}

export type Status =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: Ready }
  | { readonly status: "failed"; readonly error: Error }

export interface Interface {
  readonly status: () => Effect.Effect<Status>
  readonly awaitReady: () => Effect.Effect<Ready, Error>
}

interface Attempt {
  readonly deferred: Deferred.Deferred<Ready, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ProjectResolution") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const lifecycle = yield* LocationLifecycle.capture()
    const location = yield* Location.Service
    const project = yield* Project.Service
    const scope = yield* Scope.Scope
    const initial = { deferred: yield* Deferred.make<Ready, Error>() }
    const current = yield* Ref.make<Attempt>(initial)

    const launch = Effect.fnUntraced(function* (attempt: Attempt) {
      const warmup = Effect.gen(function* () {
        const resolved = yield* project.resolveStrict(location.directory).pipe(
          Effect.mapError((cause) =>
            cause instanceof Git.DiscoveryError
              ? new GitFailedError({ cause })
              : new FileSystemFailedError({ cause }),
          ),
        )
        if (config.loadProject)
          yield* config
            .loadProject(resolved.directory)
            .pipe(Effect.mapError((cause) => new FileSystemFailedError({ cause })))
        return { project: resolved, repository: resolved.repository }
      })
      yield* Effect.acquireUseRelease(
        LocationLifecycle.registerCaptured(lifecycle, "fiber", "vcs-warmup").pipe(Effect.uninterruptible),
        (registration) => Effect.gen(function* () {
          if (registration._tag === "closed") return Deferred.interrupt(attempt.deferred)
          const entries = config.bootstrapEntries
            ? yield* config.bootstrapEntries()
            : yield* config.entries()
          const deadline = ConfigProjectResolution.deadline(
            Config.latest(entries, "project_resolution"),
          )
          yield* Deferred.complete(
            attempt.deferred,
            warmup.pipe(
              Effect.timeoutOrElse({
                duration: deadline,
                orElse: () => Effect.fail(new TimedOutError({ deadline_ms: deadline })),
              }),
              Effect.tapError(() => (config.loadFallback ? config.loadFallback() : Effect.void)),
            ),
          )
        }),
        (registration) => (registration._tag === "tracked" ? registration.unregister : Effect.void),
      ).pipe(Effect.forkIn(scope, { startImmediately: true }))
    })

    yield* launch(initial)

    return Service.of({
      status: Effect.fn("ProjectResolution.status")(function* () {
        return yield* Deferred.poll((yield* Ref.get(current)).deferred).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed<Status>({ status: "loading" }),
              onSome: (result) =>
                result.pipe(
                  Effect.match({
                    onFailure: (error): Status => ({ status: "failed", error }),
                    onSuccess: (value): Status => ({ status: "ready", value }),
                  }),
                ),
            }),
          ),
        )
      }),
      awaitReady: Effect.fn("ProjectResolution.awaitReady")(function* () {
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const observed = yield* Ref.get(current)
            const polled = yield* Deferred.poll(observed.deferred)
            // In-flight callers observe this attempt directly; callers after its failure start one shared retry.
            if (Option.isNone(polled)) return yield* restore(Deferred.await(observed.deferred))
            const exit = yield* Effect.exit(polled.value)
            if (Exit.isSuccess(exit)) return exit.value

            const replacement = { deferred: yield* Deferred.make<Ready, Error>() }
            const selected = yield* Ref.modify(current, (active) =>
              active === observed ? [replacement, replacement] : [active, active],
            )
            if (selected === replacement) yield* launch(replacement)
            return yield* restore(Deferred.await(selected.deferred))
          }),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Location.node, Project.node],
})
