import { Effect, Layer, Option } from "effect"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Npm } from "@ranex/core/npm"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"

const directory = process.env["TEST_DIRECTORY"]
if (!directory) throw new Error("TEST_DIRECTORY is required")

const config = await Effect.runPromise(
  Effect.gen(function* () {
    const config = yield* Config.Service
    return yield* config.get()
  }).pipe(
    Effect.provideService(InstanceRef, { directory, worktree: directory, project: {} as never }),
    Effect.provide(
      LayerNode.compile(Config.node, [
        [Npm.node, Layer.mock(Npm.Service)({ install: () => Effect.void })],
        [Account.node, Layer.mock(Account.Service)({ active: () => Effect.succeed(Option.none()) })],
      ]),
    ),
    Effect.scoped,
  ),
)

console.log(`__RESULT__${JSON.stringify({ model: config.model, username: config.username })}`)
