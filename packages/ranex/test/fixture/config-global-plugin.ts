import { Cause, Effect, Exit, Layer, Option } from "effect"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { ConfigErrorV1 } from "@ranex/core/v1/config/error"
import { Npm } from "@ranex/core/npm"
import { Account } from "@/account/account"
import { Config } from "@/config/config"

const exit = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const config = yield* Config.Service
    return yield* config.getGlobal()
  }).pipe(
    Effect.provide(
      LayerNode.compile(Config.node, [
        [Npm.node, Layer.mock(Npm.Service)({ install: () => Effect.void })],
        [Account.node, Layer.mock(Account.Service)({ active: () => Effect.succeed(Option.none()) })],
      ]),
    ),
    Effect.scoped,
  ),
)

if (Exit.isSuccess(exit)) throw new Error("expected legacy plugin config to fail")
const error = Cause.squash(exit.cause)
if (!ConfigErrorV1.InvalidError.isInstance(error)) throw error
console.log(`__ERROR__${JSON.stringify(error.toObject())}`)
