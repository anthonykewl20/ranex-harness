import { Effect } from "effect"
import { define } from "../internal"

export const RanexNoopPlugin = define({
  id: "ranex-noop",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      catalog.provider.update("ranex-noop", (provider) => {
        provider.name = "Ranex Noop"
        provider.api = { type: "native", settings: {} }
      })
      catalog.model.update("ranex-noop", "noop", (model) => {
        model.name = "Noop"
        model.api = { id: "noop", type: "native", settings: {} }
        model.capabilities = { tools: false, input: ["text"], output: ["text"] }
        model.cost = []
        model.enabled = true
        model.status = "active"
        model.limit = { context: 128_000, output: 128 }
      })
    })
  }),
})
