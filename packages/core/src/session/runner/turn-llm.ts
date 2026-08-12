export * as SessionTurnLLM from "./turn-llm"

import { LLMClient, RequestExecutor, type LLMClientService, type LLMClientShape } from "@ranex/llm/route"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../../effect/app-node"
import { httpClient } from "../../effect/app-node-platform"

export class Service extends Context.Service<Service, LLMClientShape>()("@opencode/v2/SessionTurnLLM") {}

export const layerFrom = <E, R>(client: Layer.Layer<LLMClientService, E, R>) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of(yield* LLMClient.Service)
    }),
  ).pipe(Layer.provide(client))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const client = yield* LLMClient.Service
    return Service.of(client)
  }),
).pipe(Layer.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.singleAttemptLayer))))

export const node = makeLocationNode({ service: Service, layer, deps: [httpClient] })
