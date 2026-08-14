export * as Policy from "./policy"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect as EffectRuntime, Layer, Schema } from "effect"
import { Wildcard } from "./util/wildcard"
import { Location } from "./location"

export const Effect = Schema.Literals(["allow", "deny"]).annotate({ identifier: "Policy.Effect" })
export type Effect = typeof Effect.Type

export class Info extends Schema.Class<Info>("Policy.Info")({
  action: Schema.String,
  effect: Effect,
  resource: Schema.String,
}) {}

export interface Interface {
  readonly load: (statements: Info[]) => EffectRuntime.Effect<void>
  readonly evaluate: (action: string, resource: string, fallback: Effect) => EffectRuntime.Effect<Effect>
  readonly hasStatements: () => EffectRuntime.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Policy") {}

const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    let statements: Info[] = []
    const ready = yield* Deferred.make<void>()
    yield* Location.Service

    return Service.of({
      load: EffectRuntime.fn("Policy.load")(function* (input) {
        statements = input
        yield* Deferred.succeed(ready, undefined)
      }),
      hasStatements: EffectRuntime.fn("Policy.hasStatements")(function* () {
        yield* Deferred.await(ready)
        return statements.length > 0
      }),
      evaluate: EffectRuntime.fn("Policy.evaluate")(function* (action, resource, fallback) {
        yield* Deferred.await(ready)
        return (
          statements.findLast(
            (statement) => Wildcard.match(action, statement.action) && Wildcard.match(resource, statement.resource),
          )?.effect ?? fallback
        )
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node] })
