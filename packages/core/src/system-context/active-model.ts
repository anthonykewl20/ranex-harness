export * as ActiveModel from "./active-model"

import { type Model } from "@ranex/llm"
import { Effect, Schema } from "effect"
import { SystemContext } from "./index"

const Value = Schema.Struct({
  provider_id: Schema.String,
  model_id: Schema.String,
})

export const activeModel = (model: Model) =>
  SystemContext.make({
    key: SystemContext.Key.make("core/active-model"),
    codec: Schema.toCodecJson(Value),
    load: Effect.succeed({ provider_id: model.provider, model_id: model.id }),
    baseline: (value) => `Active model: ${value.provider_id}/${value.model_id}`,
    update: (previous, value) =>
      `Active model changed from ${previous.provider_id}/${previous.model_id} to ${value.provider_id}/${value.model_id}`,
  })
