import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Effect, Exit, Fiber } from "effect"
import { bootstrap as cliBootstrap } from "../../src/cli/bootstrap"
import { AppRuntime } from "../../src/effect/app-runtime"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Plugin } from "../../src/plugin"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { context } from "../../src/project/instance-context"
import { InstanceStore } from "../../src/project/instance-store"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { waitGlobalBusEvent } from "../server/global-bus"

const it = testEffect(
  LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node, Plugin.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)

// InstanceBootstrap must run before any code touches the instance.
// Built-in hooks are loaded only by the real bootstrap's Plugin.init call.

afterEach(async () => {
  await disposeAllInstances()
})

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for CLI bootstrap instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

it.live("InstanceStore.provide runs InstanceBootstrap before effect", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const store = yield* InstanceStore.Service

    const count = yield* store.provide(
      { directory },
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        return (yield* plugin.list()).length
      }),
    )

    expect(count).toBeGreaterThan(0)
  }),
)

it.live("CLI bootstrap runs InstanceBootstrap before callback", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    let count = 0

    yield* Effect.promise(() =>
      cliBootstrap(directory, async () => {
        count = await AppRuntime.runPromise(
          Plugin.Service.use((plugin) => plugin.list()).pipe(
            Effect.map((hooks) => hooks.length),
            Effect.provideService(InstanceRef, context.use()),
          ),
        )
        return "ok"
      }),
    )

    expect(count).toBeGreaterThan(0)
  }),
)

it.live("CLI bootstrap disposes the instance when the callback rejects", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const disposed = yield* waitDisposed(directory).pipe(Effect.forkScoped({ startImmediately: true }))

    const exit = yield* Effect.promise(() =>
      cliBootstrap(directory, async () => Promise.reject(new Error("boom"))),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ message: "boom" })
    yield* Fiber.join(disposed)
  }),
)

it.live("InstanceStore.reload runs InstanceBootstrap", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const store = yield* InstanceStore.Service

    yield* store.reload({ directory })
    const count = yield* store.provide(
      { directory },
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        return (yield* plugin.list()).length
      }),
    )

    expect(count).toBeGreaterThan(0)
  }),
)
