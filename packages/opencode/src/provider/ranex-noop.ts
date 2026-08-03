import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Info } from "./provider"

const text = "Ranex noop complete."

export const provider = (): Info => ({
  id: ProviderV2.ID.make("ranex-noop"),
  name: "Ranex Noop",
  source: "custom",
  env: [],
  options: {},
  models: {
    noop: {
      id: ModelV2.ID.make("noop"),
      providerID: ProviderV2.ID.make("ranex-noop"),
      api: { id: "noop", url: "", npm: "ranex-noop" },
      name: "Noop",
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: false,
        toolcall: false,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 128_000, output: 128 },
      status: "active",
      options: {},
      headers: {},
      release_date: "",
      variants: {},
    },
  },
})

export const language = {
  specificationVersion: "v3",
  provider: "ranex-noop",
  modelId: "noop",
  supportedUrls: {},
  async doGenerate() {
    return {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }
  },
  async doStream() {
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ type: "text-start", id: "ranex-noop-text" })
          controller.enqueue({ type: "text-delta", id: "ranex-noop-text", delta: text })
          controller.enqueue({ type: "text-end", id: "ranex-noop-text" })
          controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage() })
          controller.close()
        },
      }),
    }
  },
} satisfies LanguageModelV3

function usage() {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  }
}
