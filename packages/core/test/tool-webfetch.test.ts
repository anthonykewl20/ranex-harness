import { describe, expect, test } from "bun:test"
import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { PermissionV2 } from "@ranex/core/permission"
import { SessionV2 } from "@ranex/core/session"
import { ToolRegistry } from "@ranex/core/tool/registry"
import { WebFetchTool } from "@ranex/core/tool/webfetch"
import { ToolOutputStore } from "@ranex/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_webfetch_test")
const requests: Array<{ readonly url: string; readonly headers: Record<string, string> }> = []
const assertions: PermissionV2.AssertInput[] = []
let respond = (_request: HttpClientRequest.HttpClientRequest) =>
  Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => requests.push({ url: request.url, headers: request.headers })).pipe(
      Effect.andThen(respond(request)),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    ),
  ),
)
// Fake resolver so domain-name validation never touches the network in tests
let resolve: (host: string) => Promise<Array<{ address: string }>> = () =>
  Promise.resolve([{ address: "93.184.216.34" }])
const dns = Layer.succeed(
  WebFetchTool.DnsLookup,
  WebFetchTool.DnsLookup.of({ lookup: (host) => resolve(host) }),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const toolLayer = (replacements: LayerNode.Replacements = []) =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, WebFetchTool.node]), [
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [WebFetchTool.dnsLookupNode, dns],
    ...replacements,
  ])
const it = testEffect(toolLayer([[WebFetchTool.httpClientNode, http]]))
// No httpClientNode replacement: execution goes through the real node transport,
// whose DNS resolution is the pinned validated resolver.
const itPinned = testEffect(toolLayer())

const reset = () => {
  requests.length = 0
  assertions.length = 0
  respond = () => Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))
  resolve = () => Promise.resolve([{ address: "93.184.216.34" }])
}

const call = (input: typeof WebFetchTool.Input.Type, id = "call-webfetch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "webfetch", input },
})

describe("WebFetchTool helpers", () => {
  test("defaults format and rejects invalid timeout controls", () => {
    const decode = Schema.decodeUnknownSync(WebFetchTool.Input)
    expect(decode({ url: "https://example.com" })).toEqual({ url: "https://example.com", format: "markdown" })
    expect(() => decode({ url: "https://example.com", timeout: 0 })).toThrow()
    expect(() => decode({ url: "https://example.com", timeout: WebFetchTool.MAX_TIMEOUT_SECONDS + 1 })).toThrow()
  })

  test("ports HTML text and markdown conversions without active content", () => {
    const html = "<h1>Hello</h1><script>bad()</script><p>world <strong>wide</strong></p><style>.bad {}</style>"
    expect(WebFetchTool.extractTextFromHTML(html)).toBe("Helloworld wide")
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("# Hello\n\nworld **wide**")
  })
})

describe("WebFetchTool registration", () => {
  it.effect("registers and fetches an ordinary hostname HTTP URL without rewriting it", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const url = "http://example.com/public"

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["webfetch"])
      expect(yield* settleTool(registry, call({ url, format: "text", timeout: 4 }))).toEqual({
        result: { type: "text", value: "hello" },
        output: {
          structured: { url, contentType: "text/plain", format: "text", output: "hello" },
          content: [{ type: "text", text: "hello" }],
        },
      })
      expect(assertions).toMatchObject([
        { sessionID, action: "webfetch", resources: [url], save: [url], metadata: { url, format: "text", timeout: 4 } },
      ])
      expect(requests).toMatchObject([{ url, headers: { accept: expect.stringContaining("text/plain;q=1.0") } }])
    }),
  )

  it.effect("rejects loopback, private, and reserved hosts before permission or transport", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const urls = [
        "http://localhost/private",
        "http://api.localhost/private",
        "http://intranet.local/private",
        "http://127.0.0.1:8080/admin",
        "http://0x7f.000.000.001/admin",
        "http://[::ffff:127.0.0.1]/",
        "http://[::127.0.0.1]/",
        "http://[::169.254.169.254]/",
        "http://169.254.169.254./",
        "http://127.0.0.1./admin",
        "http://169.254.169.254/latest/meta-data",
        "http://10.1.2.3/",
        "http://172.16.9.9/",
        "http://192.168.1.1/",
        "http://100.64.0.1/",
        "http://0.0.0.0/",
        "http://[::1]/",
        "http://[::]/",
        "http://[fc00::1]/",
        "http://[fe80::1]/",
        "http://[::ffff:10.0.0.1]/",
        // IANA special-use ranges: benchmarking, TEST-NETs, multicast,
        // reserved, IPv6 documentation and site-local
        "http://198.18.5.5/",
        "http://192.0.2.1/",
        "http://203.0.113.9/",
        "http://224.0.0.1/",
        "http://240.1.2.3/",
        "http://[2001:db8::1]/",
        "http://[fec0::1]/",
      ]

      for (const url of urls) {
        expect(yield* executeTool(registry, call({ url, format: "text" }))).toEqual({
          type: "error",
          value: `Unable to fetch ${url}`,
        })
      }
      expect(assertions).toEqual([])
      expect(requests).toEqual([])
    }),
  )

  it.effect("refuses redirects that target private hosts", () =>
    Effect.gen(function* () {
      reset()
      respond = (request) =>
        Effect.succeed(
          new URL(request.url).pathname === "/redirect"
            ? new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
            : new Response("ok", { headers: { "content-type": "text/plain" } }),
        )
      const registry = yield* ToolRegistry.Service
      const url = "https://example.com/redirect"

      expect(yield* executeTool(registry, call({ url, format: "text" }))).toEqual({
        type: "error",
        value: `Unable to fetch ${url}`,
      })
      expect(requests.map((request) => request.url)).toEqual([url])
    }),
  )

  it.effect("rejects domains whose resolution reaches private or reserved space", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      resolve = () => Promise.resolve([{ address: "127.0.0.1" }])
      expect(yield* executeTool(registry, call({ url: "http://rebind.example.com/", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch http://rebind.example.com/",
      })
      resolve = () => Promise.resolve([{ address: "93.184.216.34" }, { address: "10.0.0.1" }])
      expect(yield* executeTool(registry, call({ url: "http://mixed.example.com/", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch http://mixed.example.com/",
      })
      resolve = () => Promise.resolve([{ address: "::ffff:169.254.169.254" }])
      expect(yield* executeTool(registry, call({ url: "http://v6.example.com/", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch http://v6.example.com/",
      })
      expect(assertions).toEqual([])
      expect(requests).toEqual([])
    }),
  )

  it.effect("rejects domains when resolution fails or returns nothing (fail-closed)", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      resolve = () => Promise.reject(new Error("ENOTFOUND"))
      expect(yield* executeTool(registry, call({ url: "http://missing.example.com/", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch http://missing.example.com/",
      })
      resolve = () => Promise.resolve([])
      expect(yield* executeTool(registry, call({ url: "http://empty.example.com/", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch http://empty.example.com/",
      })
      expect(assertions).toEqual([])
      expect(requests).toEqual([])
    }),
  )

  it.effect("allows domains that resolve to public addresses", () =>
    Effect.gen(function* () {
      reset()
      resolve = () => Promise.resolve([{ address: "93.184.216.34" }, { address: "2606:2800:220:1:248:1893:25c8:1946" }])
      const registry = yield* ToolRegistry.Service

      expect(yield* settleTool(registry, call({ url: "http://public.example.com/", format: "text" }))).toEqual({
        result: { type: "text", value: "hello" },
        output: {
          structured: {
            url: "http://public.example.com/",
            contentType: "text/plain",
            format: "text",
            output: "hello",
          },
          content: [{ type: "text", text: "hello" }],
        },
      })
    }),
  )

  it.effect("re-validates DNS resolution on every redirect hop", () =>
    Effect.gen(function* () {
      reset()
      respond = (request) =>
        Effect.succeed(
          new URL(request.url).pathname === "/redirect"
            ? new Response("", { status: 302, headers: { location: "http://rebind.example.com/target" } })
            : new Response("ok", { headers: { "content-type": "text/plain" } }),
        )
      const resolvedHosts: string[] = []
      resolve = (host) => {
        resolvedHosts.push(host)
        return Promise.resolve([{ address: host.startsWith("rebind.") ? "127.0.0.1" : "93.184.216.34" }])
      }
      const registry = yield* ToolRegistry.Service
      const url = "https://example.com/redirect"

      expect(yield* executeTool(registry, call({ url, format: "text" }))).toEqual({
        type: "error",
        value: `Unable to fetch ${url}`,
      })
      expect(requests.map((request) => request.url)).toEqual([url])
      // The resolver was consulted for the redirect target before the second hop
      expect(resolvedHosts).toEqual(["example.com", "rebind.example.com"])
    }),
  )

  it.effect("follows redirects between public hosts", () =>
    Effect.gen(function* () {
      reset()
      respond = (request) =>
        Effect.succeed(
          new URL(request.url).pathname === "/redirect"
            ? new Response("", { status: 302, headers: { location: "https://other.example.com/target" } })
            : new Response("redirected", { headers: { "content-type": "text/plain" } }),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://example.com/redirect", format: "text" }))).toEqual({
        type: "text",
        value: "redirected",
      })
      expect(requests.map((request) => request.url)).toEqual([
        "https://example.com/redirect",
        "https://other.example.com/target",
      ])
    }),
  )

  it.effect("caps redirect hops", () =>
    Effect.gen(function* () {
      reset()
      respond = (request) =>
        Effect.succeed(
          new URL(request.url).pathname === "/final"
            ? new Response("done", { headers: { "content-type": "text/plain" } })
            : new Response("", { status: 302, headers: { location: "/hop" } }),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://example.com/start", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://example.com/start",
      })
      expect(requests).toHaveLength(6)
    }),
  )

  it.effect("rejects non-HTTP schemes before permission or transport", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "file:///etc/passwd", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch file:///etc/passwd",
      })
      expect(assertions).toEqual([])
      expect(requests).toEqual([])
    }),
  )

  it.effect("converts HTML to requested markdown and text", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<h1>Hello</h1><p>world</p><script>bad()</script>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "markdown" }))).toEqual({
        type: "text",
        value: "# Hello\n\nworld",
      })
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "text" }))).toEqual({
        type: "text",
        value: "Helloworld",
      })
    }),
  )

  it.effect("returns an error result when HTML-to-Markdown conversion throws", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<div>".repeat(10_000) + "content" + "</div>".repeat(10_000), {
            headers: { "content-type": "text/html" },
          }),
        )
      const registry = yield* ToolRegistry.Service
      const url = "https://1.1.1.1/deep-html"

      expect(yield* executeTool(registry, call({ url, format: "markdown" }))).toEqual({
        type: "error",
        value: `Unable to fetch ${url}`,
      })
    }),
  )

  it.effect("rejects declared and streamed oversized bodies", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      respond = () =>
        Effect.succeed(
          new Response("small", {
            headers: { "content-type": "text/plain", "content-length": String(WebFetchTool.MAX_RESPONSE_BYTES + 1) },
          }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/declared", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/declared",
      })

      respond = () =>
        Effect.succeed(
          new Response("x".repeat(WebFetchTool.MAX_RESPONSE_BYTES + 1), { headers: { "content-type": "text/plain" } }),
        )
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/streamed", format: "text" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/streamed",
      })
    }),
  )

  it.effect("keeps images and files unsupported until typed settlement can carry attachments", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      respond = () => Effect.succeed(new Response("png", { headers: { "content-type": "image/png" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/image", format: "html" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/image",
      })

      respond = () => Effect.succeed(new Response("pdf", { headers: { "content-type": "application/pdf" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/file", format: "html" }))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/file",
      })
    }),
  )

  it.effect("retries Cloudflare challenges with an honest user agent", () =>
    Effect.gen(function* () {
      reset()
      let count = 0
      respond = () =>
        Effect.succeed(
          ++count === 1
            ? new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } })
            : new Response("ok", { headers: { "content-type": "text/plain" } }),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "text" }))).toEqual({
        type: "text",
        value: "ok",
      })
      expect(requests).toHaveLength(2)
      expect(requests[0]?.headers["user-agent"]).toContain("Mozilla/5.0")
      expect(requests[1]?.headers["user-agent"]).toBe("opencode")
    }),
  )

  it.effect("times out stalled requests", () =>
    Effect.gen(function* () {
      reset()
      respond = () => Effect.never
      const registry = yield* ToolRegistry.Service
      const fiber = yield* executeTool(
        registry,
        call({ url: "https://1.1.1.1/slow", format: "text", timeout: 1 }),
      ).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(1))

      expect(yield* Fiber.join(fiber)).toEqual({ type: "error", value: "Unable to fetch https://1.1.1.1/slow" })
    }),
  )
})

describe("WebFetchTool connection-pinned DNS validation", () => {
  itPinned.live("invokes the injected resolver when the request executes (pinning proof)", () =>
    Effect.gen(function* () {
      reset()
      const calls: string[] = []
      resolve = (host) => {
        calls.push(host)
        // A genuinely public address (the RFC 5737 TEST-NETs are refused by
        // the guard): the connection itself need not succeed — what matters is
        // that validation passed and the fetch resolved DNS through the pinned
        // resolver.
        return Promise.resolve([{ address: "93.184.216.34" }])
      }
      const registry = yield* ToolRegistry.Service
      const url = "http://pinned.example.com/"

      yield* executeTool(registry, call({ url, format: "text", timeout: 1 }))
      // Pre-flight is the only other caller: a second invocation means the actual
      // fetch resolved DNS through the injected (validated) resolver.
      expect(calls.length).toBeGreaterThanOrEqual(2)
      expect(calls.every((host) => host === "pinned.example.com")).toBe(true)
    }),
  )

  itPinned.live("refuses a rebound hostname that only turns private at connect time", () =>
    Effect.gen(function* () {
      reset()
      const answers = [["93.184.216.34"], ["169.254.169.254"]]
      let n = 0
      resolve = () => Promise.resolve(answers[Math.min(n++, 1)].map((address) => ({ address })))
      const registry = yield* ToolRegistry.Service
      const url = "http://rebind.example.com/"

      expect(yield* executeTool(registry, call({ url, format: "text", timeout: 2 }))).toEqual({
        type: "error",
        value: `Unable to fetch ${url}`,
      })
      expect(n).toBeGreaterThanOrEqual(2)
    }),
  )

  itPinned.live("refuses a mixed public and private answer set at connect time", () =>
    Effect.gen(function* () {
      reset()
      const answers = [["93.184.216.34"], ["93.184.216.34", "10.0.0.1"]]
      let n = 0
      resolve = () => Promise.resolve(answers[Math.min(n++, 1)].map((address) => ({ address })))
      const registry = yield* ToolRegistry.Service
      const url = "http://mixed.example.com/"

      expect(yield* executeTool(registry, call({ url, format: "text", timeout: 2 }))).toEqual({
        type: "error",
        value: `Unable to fetch ${url}`,
      })
      expect(n).toBeGreaterThanOrEqual(2)
    }),
  )

  itPinned.live("fails closed when connect-time resolution returns nothing", () =>
    Effect.gen(function* () {
      reset()
      const answers = [["93.184.216.34"], []]
      let n = 0
      resolve = () => Promise.resolve(answers[Math.min(n++, 1)].map((address) => ({ address })))
      const registry = yield* ToolRegistry.Service
      const url = "http://empty.example.com/"

      expect(yield* executeTool(registry, call({ url, format: "text", timeout: 2 }))).toEqual({
        type: "error",
        value: `Unable to fetch ${url}`,
      })
      expect(n).toBeGreaterThanOrEqual(2)
    }),
  )
})
