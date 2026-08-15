import { describe, expect } from "bun:test"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { httpClient } from "@ranex/core/effect/app-node-platform"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { DnsLookup, HttpTransport, WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const requests: string[] = []
let respond = (_url: URL) => new Response("hello", { headers: { "content-type": "text/plain" } })

// The SSRF guard rejects loopback targets, so tests stub the transport instead
// of serving from localhost and use public hostnames.
const fakeClient = HttpClient.make((request) =>
  Effect.sync(() => {
    requests.push(request.url)
    return HttpClientResponse.fromWeb(request, respond(new URL(request.url)))
  }),
)

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node])),
    // Fake resolver so domain-name validation never touches the network in tests
    Layer.succeed(DnsLookup, DnsLookup.of({ lookup: () => Promise.resolve([{ address: "93.184.216.34" }]) })),
    // Fake transport so response handling is exercised without networking
    Layer.succeed(HttpTransport, HttpTransport.of({ client: fakeClient })),
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const reset = () => {
  requests.length = 0
  respond = () => new Response("hello", { headers: { "content-type": "text/plain" } })
}

const exec = Effect.fn("WebFetchToolTest.exec")(function* (args: Tool.InferParameters<typeof WebFetchTool>) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.webfetch", () => {
  it.instance("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      reset()
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      respond = () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } })
      const result = yield* exec({ url: "https://example.com/image.png", format: "markdown" })
      expect(result.output).toBe("Image fetched successfully")
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0].type).toBe("file")
      expect(result.attachments?.[0].mime).toBe("image/png")
      expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.instance("keeps svg as text output", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>', {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        })
      const result = yield* exec({ url: "https://example.com/image.svg", format: "html" })
      expect(result.output).toContain("<svg")
      expect(result.attachments).toBeUndefined()
    }),
  )

  it.instance("keeps text responses as text output", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      const result = yield* exec({ url: "https://example.com/file.txt", format: "text" })
      expect(result.output).toBe("hello from webfetch")
      expect(result.attachments).toBeUndefined()
    }),
  )

  it.instance("extracts text from html without scripts or styles", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        new Response(
          "<html><head><style>.hidden{}</style><script>alert('x')</script></head><body>Hello <b>world</b></body></html>",
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        )
      const result = yield* exec({ url: "https://example.com/page.html", format: "text" })
      expect(result.output).toBe("Hello world")
      expect(result.attachments).toBeUndefined()
    }),
  )
})
