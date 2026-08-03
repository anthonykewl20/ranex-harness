import { LLMEvent, Model } from "@opencode-ai/llm"
import { Endpoint, Protocol, Route, type TransportDef } from "@opencode-ai/llm/route"
import { Effect, Schema, Stream } from "effect"

const protocol = Protocol.make({
  id: "ranex-noop",
  body: {
    schema: Schema.Struct({}),
    from: () => Effect.succeed({}),
  },
  stream: {
    event: Schema.Literal("complete"),
    initial: () => undefined,
    step: (state, event) =>
      Effect.succeed([
        state,
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "ranex-noop-text" }),
          LLMEvent.textDelta({ id: "ranex-noop-text", text: "Ranex noop complete." }),
          LLMEvent.textEnd({ id: "ranex-noop-text" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]),
  },
})

const transport = {
  id: "ranex-noop",
  prepare: () => Effect.succeed(undefined),
  frames: () => Stream.succeed("complete"),
} satisfies TransportDef<{}, undefined, "complete">

const route = Route.make({
  id: "ranex-noop",
  provider: "ranex-noop",
  protocol,
  endpoint: Endpoint.path("/", { baseURL: "http://ranex-noop.invalid" }),
  transport,
})

export const model = () => route.model({ id: "noop" })
