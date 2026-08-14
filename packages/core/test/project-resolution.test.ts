import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Config } from "@ranex/core/config"
import { ConfigProjectResolution } from "@ranex/core/config/project-resolution"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { FSUtil } from "@ranex/core/fs-util"
import { Git } from "@ranex/core/git"
import { Location } from "@ranex/core/location"
import { Project } from "@ranex/core/project"
import { ProjectResolution } from "@ranex/core/project-resolution"
import { AbsolutePath } from "@ranex/core/schema"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make("/repo/packages/core")
const projectDirectory = AbsolutePath.make("/repo")
const ref = Location.Ref.make({ directory })
const it = testEffect(Layer.empty)

function resolved(repository?: Git.Repository): Project.Resolved {
  return {
    id: Project.ID.make("project"),
    directory: projectDirectory,
    vcs: repository ? { type: "git", store: repository.commonDirectory } : undefined,
    repository,
  }
}

function resolutionLayer(input: {
  readonly resolveStrict: Project.Interface["resolveStrict"]
  readonly deadline?: number
  readonly loadProject?: Config.Interface["loadProject"]
  readonly loadFallback?: NonNullable<Config.Interface["loadFallback"]>
}) {
  const entries = input.deadline
    ? [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            project_resolution: new ConfigProjectResolution.Info({ deadline_ms: input.deadline }),
          }),
        }),
      ]
    : []
  const config = Config.Service.of({
    entries: () => Effect.succeed(entries),
    loadProject: input.loadProject,
    loadFallback: input.loadFallback,
  })
  return AppNodeBuilder.build(ProjectResolution.node, [
    [Config.node, Layer.succeed(Config.Service, config)],
    [Location.node, Location.boundNode(ref)],
    [
      Project.node,
      Layer.succeed(
        Project.Service,
        Project.Service.of({
          directories: () => Effect.succeed([]),
          resolve: (directory) => input.resolveStrict(directory).pipe(Effect.orDie),
          resolveStrict: input.resolveStrict,
          commit: () => Effect.void,
        }),
      ),
    ],
  ])
}

describe("ProjectResolution", () => {
  it.effect("binds without waiting and shares the initial warm-up repository", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<Project.Resolved>()
      const started = yield* Deferred.make<void>()
      const repository = new Git.Repository({
        worktree: projectDirectory,
        gitDirectory: AbsolutePath.make("/repo/.git"),
        commonDirectory: AbsolutePath.make("/repo/.git"),
      })
      let calls = 0
      yield* Effect.gen(function* () {
        const resolution = yield* ProjectResolution.Service
        yield* Deferred.await(started)
        expect(yield* resolution.status()).toEqual({ status: "loading" })

        const first = yield* resolution.awaitReady().pipe(Effect.forkScoped)
        const second = yield* resolution.awaitReady().pipe(Effect.forkScoped)
        yield* Deferred.succeed(gate, resolved(repository))
        const values = yield* Effect.all([Fiber.join(first), Fiber.join(second)], { concurrency: "unbounded" })

        expect(calls).toBe(1)
        expect(values[0]?.repository).toBe(repository)
        expect(values[1]?.repository).toBe(repository)
        expect(yield* resolution.status()).toEqual({ status: "ready", value: values[0] })
      }).pipe(
        Effect.provide(
          resolutionLayer({
            resolveStrict: () =>
              Effect.gen(function* () {
                calls++
                yield* Deferred.succeed(started, undefined)
                return yield* Deferred.await(gate)
              }),
          }),
        ),
        Effect.scoped,
      )
    }),
  )

  it.effect("starts one new shared warm-up after a Git failure", () =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<Project.Resolved, Git.DiscoveryError | FSUtil.Error>()
      const second = yield* Deferred.make<Project.Resolved, Git.DiscoveryError | FSUtil.Error>()
      const firstStarted = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const failure = new Git.DiscoveryError({ directory, message: "git failed" })
      let calls = 0
      yield* Effect.gen(function* () {
        const resolution = yield* ProjectResolution.Service
        yield* Deferred.await(firstStarted)
        const initial = yield* resolution.awaitReady().pipe(Effect.flip, Effect.forkScoped)
        yield* Effect.yieldNow
        yield* Deferred.fail(first, failure)
        expect(yield* Fiber.join(initial)).toMatchObject({ _tag: "git_failed", cause: failure })
        expect(yield* resolution.status()).toMatchObject({ status: "failed", error: { _tag: "git_failed" } })

        const retries = yield* Effect.all(
          [resolution.awaitReady().pipe(Effect.forkScoped), resolution.awaitReady().pipe(Effect.forkScoped)],
          { concurrency: "unbounded" },
        )
        yield* Deferred.await(secondStarted)
        expect(calls).toBe(2)
        yield* Deferred.succeed(second, resolved())
        const values = yield* Effect.all(retries.map(Fiber.join), { concurrency: "unbounded" })

        expect(values).toEqual([values[0], values[0]])
        expect(calls).toBe(2)
      }).pipe(
        Effect.provide(
          resolutionLayer({
            resolveStrict: () =>
              Effect.gen(function* () {
                const gate = calls++ === 0 ? first : second
                yield* Deferred.succeed(calls === 1 ? firstStarted : secondStarted, undefined)
                return yield* Deferred.await(gate)
              }),
          }),
        ),
        Effect.scoped,
      )
    }),
  )

  it.effect("times out and interrupts the resolver itself", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      let calls = 0
      yield* Effect.gen(function* () {
        const resolution = yield* ProjectResolution.Service
        yield* Deferred.await(started)
        const waiting = yield* resolution.awaitReady().pipe(Effect.flip, Effect.forkScoped)
        yield* TestClock.adjust("100 millis")

        expect(yield* Fiber.join(waiting)).toEqual(
          new ProjectResolution.TimedOutError({ deadline_ms: 100 }),
        )
        yield* Deferred.await(interrupted)
        expect(yield* resolution.status()).toMatchObject({ status: "failed", error: { _tag: "timed_out" } })
        expect(yield* resolution.awaitReady()).toEqual({ project: resolved(), repository: undefined })
        expect(calls).toBe(2)
        expect(yield* resolution.status()).toMatchObject({ status: "ready" })
      }).pipe(
        Effect.provide(
          resolutionLayer({
            deadline: 100,
            resolveStrict: () => {
              if (calls++ > 0) return Effect.succeed(resolved())
              return Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              )
            },
          }),
        ),
        Effect.scoped,
      )
    }),
  )

  it.effect("reports filesystem failures with their typed cause", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<Project.Resolved, FSUtil.FileSystemError>()
      const started = yield* Deferred.make<void>()
      const failure = new FSUtil.FileSystemError({ method: "up" })
      let fallback = false
      yield* Effect.gen(function* () {
        const resolution = yield* ProjectResolution.Service
        yield* Deferred.await(started)
        const waiting = yield* resolution.awaitReady().pipe(Effect.flip, Effect.forkScoped)
        yield* Effect.yieldNow
        yield* Deferred.fail(gate, failure)

        expect(yield* Fiber.join(waiting)).toMatchObject({ _tag: "filesystem_failed", cause: failure })
        expect(fallback).toBe(true)
      }).pipe(
        Effect.provide(
          resolutionLayer({
            loadFallback: () => Effect.sync(() => {
              fallback = true
            }),
            resolveStrict: () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate))),
          }),
        ),
        Effect.scoped,
      )
    }),
  )

  it.effect("loads project configuration only after the correct boundary resolves", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<Project.Resolved>()
      const started = yield* Deferred.make<void>()
      let loaded: AbsolutePath | undefined
      yield* Effect.gen(function* () {
        const resolution = yield* ProjectResolution.Service
        yield* Deferred.await(started)
        expect(loaded).toBeUndefined()
        yield* Deferred.succeed(gate, resolved())
        yield* resolution.awaitReady()
        expect(loaded).toBe(projectDirectory)
      }).pipe(
        Effect.provide(
          resolutionLayer({
            loadProject: (boundary) => Effect.sync(() => {
              loaded = boundary
            }),
            resolveStrict: () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate))),
          }),
        ),
        Effect.scoped,
      )
    }),
  )
})
