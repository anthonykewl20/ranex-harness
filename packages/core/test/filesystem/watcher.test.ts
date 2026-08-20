import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ConfigProvider, Deferred, Duration, Effect, Fiber, Layer, Logger, Option, Stream } from "effect"
import { Config } from "@ranex/core/config"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { EventV2 } from "@ranex/core/event"
import { FSUtil } from "@ranex/core/fs-util"
import { Watcher } from "@ranex/core/filesystem/watcher"
import { Git } from "@ranex/core/git"
import { Global } from "@ranex/core/global"
import { Location } from "@ranex/core/location"
import { Project } from "@ranex/core/project"
import { ProjectResolution } from "@ranex/core/project-resolution"
import { AbsolutePath } from "@ranex/core/schema"
import { SkillV2 } from "@ranex/core/skill"
import { SkillWatch } from "@ranex/core/skill/watch"
import { Snapshot } from "@ranex/core/snapshot"
import { location, projectResolutionLayer } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const describeWatcher = Watcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip

type WatcherEvent = { file: string; event: "add" | "change" | "unlink" }

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node, EventV2.node])))

const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
  }),
)

const flagsLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    RANEX_EXPERIMENTAL_FILEWATCHER: "true",
    RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
  }),
)

function provide(directory: string, vcs?: Project.Vcs) {
  const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
  const repository = vcs
    ? new Git.Repository({
        worktree: AbsolutePath.make(directory),
        gitDirectory: vcs.store,
        commonDirectory: vcs.store,
      })
    : undefined
  return provideResolution(directory, projectResolutionLayer(ref, { vcs, repository }))
}

function provideResolution(directory: string, resolutionLayer: Layer.Layer<ProjectResolution.Service>) {
  const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
  return Effect.provide(
    AppNodeBuilder.build(Watcher.node, [
      [Config.node, configLayer],
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(location(ref)))],
      [ProjectResolution.node, resolutionLayer],
    ]).pipe(Layer.provide(flagsLayer)),
  )
}

function withTmp<A, E, R>(
  f: (directory: string, vcs?: Project.Vcs) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; init?: (directory: string) => Promise<void> },
) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const tmp = await tmpdir()
      if (!options?.git) return { tmp, vcs: undefined }
      await $`git init`.cwd(tmp.path).quiet()
      await $`git config core.fsmonitor false`.cwd(tmp.path).quiet()
      await $`git config commit.gpgsign false`.cwd(tmp.path).quiet()
      await $`git config user.email test@opencode.test`.cwd(tmp.path).quiet()
      await $`git config user.name Test`.cwd(tmp.path).quiet()
      await $`git commit --allow-empty -m root`.cwd(tmp.path).quiet()
      await options.init?.(tmp.path)
      return { tmp, vcs: { type: "git" as const, store: AbsolutePath.make(path.join(tmp.path, ".git")) } }
    }),
    ({ tmp }) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap(({ tmp, vcs }) => f(tmp.path, vcs).pipe(provide(tmp.path, vcs))))
}

function wait(check: (event: WatcherEvent) => boolean) {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    const deferred = yield* Deferred.make<WatcherEvent>()
    const fiber = yield* events.subscribe(Watcher.Event.Updated).pipe(
      Stream.runForEach((event) => {
        if (!check(event.data)) return Effect.void
        return Deferred.succeed(deferred, event.data).pipe(Effect.asVoid)
      }),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    return { deferred, fiber }
  })
}

function maybeNextUpdate<E>(
  check: (event: WatcherEvent) => boolean,
  trigger: Effect.Effect<void, E>,
  timeout: Duration.Input = "5 seconds",
) {
  return Effect.acquireUseRelease(
    wait(check),
    ({ deferred }) => trigger.pipe(Effect.andThen(Deferred.await(deferred)), Effect.timeoutOption(timeout)),
    ({ fiber }) => Fiber.interrupt(fiber),
  )
}

function nextUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: Effect.Effect<void, E>) {
  return Effect.gen(function* () {
    const result = yield* maybeNextUpdate(check, trigger)
    if (Option.isSome(result)) return result.value
    return yield* Effect.fail(new Error("timed out waiting for file watcher update"))
  })
}

function eventuallyUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: () => Effect.Effect<void, E>) {
  return Effect.gen(function* () {
    while (true) {
      const result = yield* maybeNextUpdate(check, trigger(), "250 millis")
      if (Option.isSome(result)) return result.value
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for file watcher readiness")),
    }),
  )
}

function noUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: Effect.Effect<void, E>, timeout = 500) {
  return Effect.acquireUseRelease(
    wait(check),
    ({ deferred }) =>
      trigger.pipe(
        Effect.andThen(Deferred.await(deferred)),
        Effect.timeoutOption(`${timeout} millis`),
        Effect.tap((result) => Effect.sync(() => expect(result).toEqual(Option.none()))),
      ),
    ({ fiber }) => Fiber.interrupt(fiber),
  )
}

function ready(directory: string) {
  const file = path.join(directory, `.watcher-${Math.random().toString(36).slice(2)}`)
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* eventuallyUpdate(
      (event) => event.file === file,
      () => fs.writeFileString(file, `ready-${Math.random()}`),
    ).pipe(Effect.ensuring(fs.remove(file, { force: true }).pipe(Effect.ignore)), Effect.asVoid)
  })
}

function withScratch<A, E, R>(f: (root: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))
}

type RecordedLog = { level: string; message: unknown }

function recordingLogger(entries: RecordedLog[]) {
  return Logger.make((options) => {
    entries.push({ level: options.logLevel, message: options.message })
  })
}

const errorAndWarnEntries = (entries: RecordedLog[]) =>
  entries.filter((entry) => entry.level === "Error" || entry.level === "Warn")

const logText = (entries: RecordedLog[]) => JSON.stringify(entries.map((entry) => entry.message))

describeWatcher("Watcher", () => {
  it.live("starts the root subscription while project resolution is loading", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const resolutionReady = yield* Deferred.make<ProjectResolution.Ready, ProjectResolution.Error>()
          yield* Effect.gen(function* () {
            yield* ready(tmp.path)
          }).pipe(
            provideResolution(
              tmp.path,
              Layer.succeed(
                ProjectResolution.Service,
                ProjectResolution.Service.of({
                  status: () => Effect.succeed({ status: "loading" }),
                  awaitReady: () => Deferred.await(resolutionReady),
                }),
              ),
            ),
            Effect.scoped,
          )
        }),
      ),
    ),
  )

  it.live("publishes root create, update, and delete events", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const file = path.join(directory, "watch.txt")
          yield* ready(directory)
          for (const item of [
            { event: "add" as const, trigger: fs.writeFileString(file, "a") },
            { event: "change" as const, trigger: fs.writeFileString(file, "b") },
            { event: "unlink" as const, trigger: fs.remove(file) },
          ]) {
            expect(
              yield* nextUpdate((event) => event.file === file && event.event === item.event, item.trigger),
            ).toEqual({
              file,
              event: item.event,
            })
          }
        }),
      { git: true },
    ),
  )

  it.live("skips non-git roots", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const file = path.join(directory, "plain.txt")
        yield* noUpdate((event) => event.file === file, fs.writeFileString(file, "plain"))
      }),
    ),
  )

  it.live("cleanup stops publishing events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const fs = yield* FSUtil.Service
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      yield* ready(tmp.path).pipe(
        provide(tmp.path, { type: "git", store: AbsolutePath.make(path.join(tmp.path, ".git")) }),
        Effect.scoped,
      )
      const file = path.join(tmp.path, "after-dispose.txt")
      yield* noUpdate((event) => event.file === file, fs.writeFileString(file, "gone")).pipe(
        Effect.provideService(EventV2.Service, events),
      )
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([FSUtil.node, EventV2.node])))),
  )

  it.live("ignores .git/index changes", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const index = path.join(directory, ".git", "index")
          yield* ready(directory)
          yield* noUpdate(
            (event) => event.file === index,
            fs
              .writeFileString(path.join(directory, "tracked.txt"), "a")
              .pipe(Effect.andThen(Effect.promise(() => $`git add .`.cwd(directory).quiet())), Effect.asVoid),
          )
        }),
      { git: true },
    ),
  )

  it.live("publishes .git/HEAD events", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const head = path.join(directory, ".git", "HEAD")
          const branch = `watch-${Math.random().toString(36).slice(2)}`
          yield* ready(directory)
          yield* Effect.promise(() => $`git branch ${branch}`.cwd(directory).quiet())
          expect(
            yield* nextUpdate((event) => event.file === head, fs.writeFileString(head, `ref: refs/heads/${branch}\n`)),
          ).toMatchObject({ file: head })
        }),
      { git: true },
    ),
  )

  it.live("shares one repository discovery between Snapshot and Watcher", () =>
    Effect.acquireRelease(
      Effect.all([Effect.promise(() => tmpdir()), Effect.promise(() => tmpdir())]),
      (directories) =>
        Effect.all(directories.map((directory) => Effect.promise(() => directory[Symbol.asyncDispose]()))),
    ).pipe(
      Effect.flatMap(([project, data]) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await $`git init`.cwd(project.path).quiet()
            await $`git config core.fsmonitor false`.cwd(project.path).quiet()
            await $`git config commit.gpgsign false`.cwd(project.path).quiet()
            await $`git config user.email test@opencode.test`.cwd(project.path).quiet()
            await $`git config user.name Test`.cwd(project.path).quiet()
            await $`git commit --allow-empty -m root`.cwd(project.path).quiet()
          })
          const directory = AbsolutePath.make(project.path)
          const store = AbsolutePath.make(path.join(project.path, ".git"))
          const repository = new Git.Repository({
            worktree: directory,
            gitDirectory: store,
            commonDirectory: store,
          })
          const resolved = {
            id: Project.ID.make("shared-repository"),
            directory,
            vcs: { type: "git" as const, store },
            repository,
          }
          let discoveries = 0
          const projectLayer = Layer.succeed(
            Project.Service,
            Project.Service.of({
              directories: () => Effect.succeed([]),
              resolve: () => Effect.succeed(resolved),
              resolveStrict: () => Effect.sync(() => {
                discoveries++
                return resolved
              }),
              commit: () => Effect.void,
            }),
          )

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            expect(yield* snapshot.capture()).toBeDefined()
            const fs = yield* FSUtil.Service
            const head = path.join(project.path, ".git", "HEAD")
            const branch = `shared-${Math.random().toString(36).slice(2)}`
            yield* Effect.promise(() => $`git branch ${branch}`.cwd(project.path).quiet())
            expect(
              yield* eventuallyUpdate(
                (event) => event.file === head,
                () => fs.writeFileString(head, `ref: refs/heads/${branch}\n`),
              ),
            ).toMatchObject({ file: head })
            expect(discoveries).toBe(1)
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(LayerNode.group([Watcher.node, Snapshot.node]), [
                [Config.node, configLayer],
                [Location.node, Location.boundNode(Location.Ref.make({ directory }))],
                [Project.node, projectLayer],
                [Global.node, Global.layerWith({ data: data.path, config: path.join(data.path, "config") })],
              ]).pipe(Layer.provide(flagsLayer)),
            ),
            Effect.scoped,
          )
        }),
      ),
    ),
  )

  describe("subscribe failure classification", () => {
    it.live("missing directory subscribe failure emits no ERROR or WARN and is returned as failed", () =>
      withScratch((root) => {
        const entries: RecordedLog[] = []
        const directory = path.join(root, "skill-does-not-exist")
        return Effect.gen(function* () {
          const watchSet = yield* Watcher.makeWatchSet(() => {})
          const result = yield* watchSet.reconcile([directory]).pipe(
            Effect.provide(Logger.layer([recordingLogger(entries)])),
          )
          expect(result.failed).toEqual([directory])
          expect(result.subscribed).toEqual([])
          expect(result.removed).toEqual([])
          expect(errorAndWarnEntries(entries)).toEqual([])
          yield* watchSet.release
        })
      }),
    )

    it.live("existing non-directory target still logs ERROR through the real subscribe path", () =>
      withScratch((root) => {
        const entries: RecordedLog[] = []
        const target = path.join(root, "not-a-directory")
        return Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(target, "regular file"))
          const watchSet = yield* Watcher.makeWatchSet(() => {})
          const result = yield* watchSet.reconcile([target]).pipe(
            Effect.provide(Logger.layer([recordingLogger(entries)])),
          )
          expect(result.failed).toEqual([target])
          const errors = entries.filter((entry) => entry.level === "Error")
          expect(errors).not.toHaveLength(0)
          expect(logText(errors)).toContain("failed to subscribe")
          expect(logText(errors)).toMatch(/ENOTDIR|Not a directory/i)
          yield* watchSet.release
        })
      }),
    )

    it.live("watcher disabled warn-once degradation is unchanged", () =>
      withScratch((root) => {
        const entries: RecordedLog[] = []
        const directory = path.join(root, "skills")
        let refreshes = 0
        const skillLayer = Layer.succeed(
          SkillV2.Service,
          SkillV2.Service.of({
            transform: () => Effect.succeed({ dispose: Effect.void }),
            reload: () => Effect.void,
            sources: () => Effect.succeed([{ type: "directory" as const, path: AbsolutePath.make(directory) }]),
            list: () => Effect.succeed([]),
            refresh: () =>
              Effect.sync(() => {
                refreshes++
              }),
          }),
        )
        return Effect.gen(function* () {
          const logs = Logger.layer([recordingLogger(entries)])
          const previous = process.env.RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER
          process.env.RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER = "1"
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER
              else process.env.RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER = previous
            }),
          )
          const skills = yield* SkillWatch.Service.pipe(
            Effect.provide(AppNodeBuilder.build(SkillWatch.node, [[SkillV2.node, skillLayer]])),
            Effect.provide(logs),
            Effect.scoped,
          )
          // sync() re-runs in the caller's context, so the recorder must be
          // provided here as well — not only around the layer build.
          yield* skills.sync().pipe(Effect.provide(logs))
          yield* skills.sync().pipe(Effect.provide(logs))
          const warnings = entries.filter((entry) => entry.level === "Warn")
          expect(warnings.filter((entry) => logText([entry]).includes("cannot watch skill directory"))).toHaveLength(1)
          expect(refreshes).toBeGreaterThanOrEqual(2)
          expect(errorAndWarnEntries(entries).filter((entry) => logText([entry]).includes("failed to subscribe"))).toEqual([])
        })
      }),
    )

    it.live("directory created after failed attempts subscribes on the next reconcile", () =>
      withScratch((root) => {
        const directory = path.join(root, "later-skills")
        const events: string[] = []
        return Effect.gen(function* () {
          const watchSet = yield* Watcher.makeWatchSet((file) => events.push(file))
          const first = yield* watchSet.reconcile([directory])
          expect(first.failed).toEqual([directory])
          yield* Effect.promise(() => fs.mkdir(directory))
          const second = yield* watchSet.reconcile([directory])
          expect(second.subscribed).toEqual([directory])
          expect(second.failed).toEqual([])
          const file = path.join(directory, "SKILL.md")
          yield* Effect.promise(() => fs.writeFile(file, "---\n"))
          for (let attempt = 0; !events.includes(file) && attempt < 100; attempt++) {
            yield* Effect.sleep("50 millis")
          }
          expect(events).toContain(file)
          yield* watchSet.release
        })
      }),
    )
  })

  const describeSymlink = process.platform !== "win32" ? describe : describe.skip
  describeSymlink("symlinked .git", () => {
    it.live("publishes .git/HEAD events through a symlinked .git directory", () =>
      withTmp(
        (directory) =>
          Effect.gen(function* () {
            const afs = yield* FSUtil.Service
            const actual = path.join(directory, "..", `actual_${path.basename(directory)}`)
            yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(actual, { recursive: true, force: true })))
            yield* ready(directory)
            const head = path.join(directory, ".git", "HEAD")
            const branch = `watch-${Math.random().toString(36).slice(2)}`
            yield* Effect.promise(() => $`git branch ${branch}`.cwd(directory).quiet())
            expect(
              yield* nextUpdate(
                (event) => event.file === path.join(actual, "HEAD"),
                afs.writeFileString(head, `ref: refs/heads/${branch}\n`),
              ),
            ).toEqual({ file: path.join(actual, "HEAD"), event: "change" })
          }),
        {
          git: true,
          init: async (directory) => {
            const actual = path.join(directory, "..", `actual_${path.basename(directory)}`)
            await fs.rename(path.join(directory, ".git"), actual)
            await fs.symlink(actual, path.join(directory, ".git"))
          },
        },
      ),
    )
  })
})
