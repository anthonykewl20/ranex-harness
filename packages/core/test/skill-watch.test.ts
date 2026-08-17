import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { AbsolutePath } from "@ranex/core/schema"
import { FSUtil } from "@ranex/core/fs-util"
import { SkillV2 } from "@ranex/core/skill"
import { SkillWatch } from "@ranex/core/skill/watch"
import { SkillDiscovery } from "@ranex/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url: string) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, SkillWatch.node]), [[SkillDiscovery.node, discovery]]),
)

// Counts re-loads of the watched skill directory: SkillV2.load() globs a
// directory source, and refresh() drops its cache key so the next list()
// re-loads — one glob per flush. Counting only globs whose cwd is the
// watched directory ignores unrelated FSUtil traffic and cached list() calls.
let watchedDirectory: string | undefined
let directoryLoads = 0
const counting = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const real = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...real,
      glob: (pattern, options) => {
        if (options?.cwd === watchedDirectory) directoryLoads++
        return real.glob(pattern, options)
      },
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const itCounting = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, SkillWatch.node]), [
    [SkillDiscovery.node, discovery],
    [FSUtil.node, counting],
  ]),
)

function write(directory: string, name: string, description: string) {
  const file = path.join(directory, name, "SKILL.md")
  return fs
    .mkdir(path.dirname(file), { recursive: true })
    .then(() =>
      fs.writeFile(
        file,
        `---
name: ${name}
description: ${description}
---
# ${name}`,
      ),
    )
}

describe("SkillWatch", () => {
  it.live("coalesces a burst of skill writes into one refresh", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const local = path.join(tmp.path, "local")
          const remote = path.join(tmp.path, "remote")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(remote, "deploy"), { recursive: true })
            await write(remote, "deploy", "Deploy production")
          })
          urls.set("https://example.test/skills/", [AbsolutePath.make(remote)])
          pulls = 0

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(local) })
            editor.source({ type: "url", url: "https://example.test/skills/" })
          })
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect(pulls).toBe(1)

          // Burst of writes into the watched directory, then a sync that
          // installs the subscriptions; both sources of activity must land in
          // the same debounced refresh.
          yield* Effect.promise(async () => {
            for (const name of ["alpha", "bravo", "charlie", "delta", "echo"]) {
              await write(local, name, `Burst ${name}`)
            }
          })
          yield* (yield* SkillWatch.Service).sync()

          const refreshed = yield* Effect.gen(function* () {
            const deadline = Date.now() + 15_000
            while (Date.now() < deadline) {
              const list = yield* skill.list()
              if (list.length === 6) return true
              yield* Effect.sleep(100)
            }
            return false
          })
          expect(refreshed).toBe(true)
          // The debounced refresh re-read the watched directory without
          // re-pulling the URL source: a local filesystem event cannot have
          // changed remote content.
          expect(pulls).toBe(1)

          // The burst landed in that one refresh: no further pulls arrive.
          yield* Effect.sleep(2500)
          expect(pulls).toBe(1)
          expect((yield* skill.list()).map((item) => item.name).toSorted()).toEqual([
            "alpha",
            "bravo",
            "charlie",
            "delta",
            "deploy",
            "echo",
          ])
        }),
      ),
    ),
    30_000,
  )

  // The pull counter cannot observe flushes anymore (refresh no longer
  // re-pulls URL sources), so pin the single-reconcile guarantee through
  // directory re-loads instead: every flush drops the directory cache key
  // and re-globs the source, so a burst coalesced by the one debounced
  // FiberHandle must re-load exactly once.
  itCounting.live("coalesces a burst of writes into one directory re-load", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const local = path.join(tmp.path, "local")
          yield* Effect.promise(() => write(local, "initial", "Initial skill"))

          watchedDirectory = local
          directoryLoads = 0
          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(local) })
          })
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["initial"])
          const baseline = directoryLoads

          // Burst of writes into the watched directory, then a sync that
          // installs the subscription and schedules the debounced flush —
          // the same path filesystem events take once subscribed.
          yield* Effect.promise(async () => {
            for (const name of ["alpha", "bravo", "charlie", "delta", "echo"]) {
              await write(local, name, `Burst ${name}`)
            }
          })
          yield* (yield* SkillWatch.Service).sync()

          // Poll the counter, never list(): a list() landing in the
          // refresh's cache-drop window would itself re-load and pollute
          // the count. The final list() runs after the quiet window, when
          // the flushed cache is warm.
          const loaded = yield* Effect.gen(function* () {
            const deadline = Date.now() + 15_000
            while (Date.now() < deadline) {
              if (directoryLoads > baseline) return true
              yield* Effect.sleep(100)
            }
            return false
          })
          expect(loaded).toBe(true)
          // Past debounce + quiet: a second flush would have re-loaded again.
          yield* Effect.sleep(2500)
          expect(directoryLoads).toBe(baseline + 1)
          expect((yield* skill.list()).map((item) => item.name).toSorted()).toEqual([
            "alpha",
            "bravo",
            "charlie",
            "delta",
            "echo",
            "initial",
          ])
        }),
      ),
    ),
    30_000,
  )

  // Watching unavailable (the disable flag is read per subscribe call, so
  // setting it here covers the layer built below): no filesystem events can
  // arrive, so sync() must degrade to revalidation — a changed skill set
  // becomes visible through sync() itself, which the 10s resync schedule
  // repeats. The plain `test` (rather than the `it` fixture) exists because
  // the env flag must be set before the layer builds, and restored after its
  // scope closed.
  test("sync refreshes skills when watching is unavailable", async () => {
    process.env.RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER = "1"
    try {
      await Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const local = path.join(tmp.path, "local")
            yield* Effect.promise(() => write(local, "initial", "Initial skill"))

            const skill = yield* SkillV2.Service
            yield* skill.transform((editor) => {
              editor.source({ type: "directory", path: AbsolutePath.make(local) })
            })
            expect((yield* skill.list()).map((item) => item.name)).toEqual(["initial"])

            // list() caches per source until refresh(); with watching
            // unavailable no event can clear the cache, so a brand-new skill
            // file stays invisible until sync() revalidates.
            yield* Effect.promise(() => write(local, "added", "Added skill"))
            expect((yield* skill.list()).map((item) => item.name)).toEqual(["initial"])

            yield* (yield* SkillWatch.Service).sync()
            expect((yield* skill.list()).map((item) => item.name).toSorted()).toEqual(["added", "initial"])
          }),
        ),
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([SkillV2.node, SkillWatch.node]), [[SkillDiscovery.node, discovery]]),
        ),
        Effect.runPromise,
      )
    } finally {
      delete process.env.RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER
    }
  }, 30_000)

  // Same fallback, but the disable flag is set AFTER the layer was built —
  // availability must be read at sync() time, not snapshotted at build, or
  // the failed subscription is misclassified as transient (no warn, no
  // interval refresh until restart).
  test("sync refreshes skills when watching is disabled after the layer was built", async () => {
    try {
      await Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const local = path.join(tmp.path, "local")
            yield* Effect.promise(() => write(local, "initial", "Initial skill"))

            const skill = yield* SkillV2.Service
            yield* skill.transform((editor) => {
              editor.source({ type: "directory", path: AbsolutePath.make(local) })
            })
            yield* Effect.sync(() => {
              process.env.RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER = "1"
            })
            expect((yield* skill.list()).map((item) => item.name)).toEqual(["initial"])

            yield* Effect.promise(() => write(local, "added", "Added skill"))
            expect((yield* skill.list()).map((item) => item.name)).toEqual(["initial"])

            yield* (yield* SkillWatch.Service).sync()
            expect((yield* skill.list()).map((item) => item.name).toSorted()).toEqual(["added", "initial"])
          }),
        ),
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([SkillV2.node, SkillWatch.node]), [[SkillDiscovery.node, discovery]]),
        ),
        Effect.runPromise,
      )
    } finally {
      delete process.env.RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER
    }
  }, 30_000)
})
