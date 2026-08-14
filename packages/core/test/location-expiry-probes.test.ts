import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { Config } from "@ranex/core/config"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { EventV2 } from "@ranex/core/event"
import { FSUtil } from "@ranex/core/fs-util"
import { Watcher } from "@ranex/core/filesystem/watcher"
import { Location } from "@ranex/core/location"
import { Pty } from "@ranex/core/pty"
import { AbsolutePath } from "@ranex/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node, EventV2.node])))
const probe = Watcher.hasNativeBinding() && process.platform === "linux" ? it.live : it.live.skip
const ptyProbe = process.platform === "win32" || !Bun.which("sh") ? it.live.skip : it.live
const flags = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    RANEX_EXPERIMENTAL_FILEWATCHER: "true",
    RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
  }),
)

function watcherLayer(directory: string) {
  return AppNodeBuilder.build(Watcher.node, [
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location(
            { directory: AbsolutePath.make(directory) },
            { vcs: { type: "git", store: AbsolutePath.make(directory) } },
          ),
        ),
      ),
    ],
  ]).pipe(Layer.provide(flags))
}

function ptyLayer(directory: string) {
  return AppNodeBuilder.build(Pty.node, [
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ],
  ])
}

function spawnInterruptedPty(directory: string, shell: string) {
  return Effect.gen(function* () {
    const pty = yield* Pty.Service
    yield* pty.create({ command: shell, args: ["-c", "sleep 30"], cwd: directory })
  }).pipe(Effect.provide(ptyLayer(directory)), Effect.scoped)
}

describe("location expiry native probes", () => {
  probe(
    "does not retain parcel watcher file descriptors after immediate scope interruption",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((directory) =>
          Effect.gen(function* () {
            const baseline = yield* Effect.promise(() => fs.readdir("/proc/self/fd").then((entries) => entries.length))

            for (let index = 0; index < 100; index++) {
              yield* Effect.gen(function* () {
                yield* Watcher.Service
                yield* Effect.yieldNow
              }).pipe(Effect.provide(watcherLayer(directory.path)), Effect.scoped)
            }

            yield* Effect.sleep("1 second")
            const final = yield* Effect.promise(() => fs.readdir("/proc/self/fd").then((entries) => entries.length))
            expect(final).toBeLessThanOrEqual(baseline + 4)
          }),
        ),
      ),
    60_000,
  )

  ptyProbe(
    "does not retain pty file descriptors after scope interruption",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((directory) =>
          Effect.gen(function* () {
            const shell = Bun.which("sh")
            if (!shell) return
            yield* spawnInterruptedPty(directory.path, shell)
            yield* Effect.sleep("1 second")
            yield* Effect.sync(() => Bun.gc(true))
            const baseline = yield* Effect.promise(() => fs.readdir("/proc/self/fd").then((entries) => entries.length))

            for (let index = 0; index < 50; index++) {
              yield* spawnInterruptedPty(directory.path, shell)
            }

            yield* Effect.sleep("1 second")
            yield* Effect.sync(() => Bun.gc(true))
            const final = yield* Effect.promise(() => fs.readdir("/proc/self/fd").then((entries) => entries.length))
            expect(final).toBeLessThanOrEqual(baseline + 4)
          }),
        ),
      ),
    60_000,
  )
})
