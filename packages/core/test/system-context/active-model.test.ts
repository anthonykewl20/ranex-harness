import { describe, expect } from "bun:test"
import { Model } from "@ranex/llm"
import { route } from "@ranex/llm/protocols/openai-chat"
import { Effect } from "effect"
import { ActiveModel } from "@ranex/core/system-context/active-model"
import { SystemContext } from "@ranex/core/system-context"
import { it } from "../lib/effect"

const resolved = Model.make({
  id: "runtime-model",
  provider: "runtime-provider",
  route: route.with({
    endpoint: { baseURL: "https://provider.example/v1" },
    headers: { "x-test": "header" },
  }),
})

describe("ActiveModel", () => {
  it.effect("stores only the runtime-resolved provider and model identifiers", () =>
    Effect.gen(function* () {
      expect(yield* SystemContext.initialize(ActiveModel.activeModel(resolved))).toEqual({
        baseline: "Active model: runtime-provider/runtime-model",
        snapshot: {
          "core/active-model": { value: { provider_id: "runtime-provider", model_id: "runtime-model" } },
        },
      })
    }),
  )

  it.effect("emits one update only when the runtime-resolved model changes", () =>
    Effect.gen(function* () {
      const previous = (yield* SystemContext.initialize(ActiveModel.activeModel(resolved))).snapshot
      const changed = Model.make({ id: "next-model", provider: "next-provider", route })

      expect(yield* SystemContext.reconcile(ActiveModel.activeModel(resolved), previous)).toEqual({ _tag: "Unchanged" })
      expect(yield* SystemContext.reconcile(ActiveModel.activeModel(changed), previous)).toEqual({
        _tag: "Updated",
        text: "Active model changed from runtime-provider/runtime-model to next-provider/next-model",
        snapshot: {
          "core/active-model": { value: { provider_id: "next-provider", model_id: "next-model" } },
        },
      })
    }),
  )
})
