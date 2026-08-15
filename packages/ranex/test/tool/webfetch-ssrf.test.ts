import { describe, expect } from "bun:test"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { httpClient } from "@ranex/core/effect/app-node-platform"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { DnsLookup, HttpTransport, WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const requests: string[] = []
let respond = (_url: URL) => new Response("ok", { headers: { "content-type": "text/plain" } })
// Fake resolver so domain-name validation never touches the network in tests
let resolve: (host: string) => Promise<Array<{ address: string }>> = () =>
  Promise.resolve([{ address: "93.184.216.34" }])

// The SSRF guard rejects loopback targets, so tests stub the transport instead
// of serving from localhost and use public hostnames.
const fakeClient = HttpClient.make((request) =>
  Effect.sync(() => {
    requests.push(request.url)
    return HttpClientResponse.fromWeb(request, respond(new URL(request.url)))
  }),
)

const dns = Layer.succeed(
  DnsLookup,
  DnsLookup.of({ lookup: (host) => resolve(host) }),
)

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node])),
    dns,
    // Fake transport so redirect and refusal behavior is exercised without networking
    Layer.succeed(HttpTransport, HttpTransport.of({ client: fakeClient })),
  ),
)

// No HttpTransport layer: execution goes through the real node transport, whose
// DNS resolution is the pinned validated resolver.
const itPinned = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([httpClient, Truncate.node, Agent.node])), dns))

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
  respond = () => new Response("ok", { headers: { "content-type": "text/plain" } })
  resolve = () => Promise.resolve([{ address: "93.184.216.34" }])
}

const exec = Effect.fn("WebFetchSSRFTest.exec")(function* (args: Tool.InferParameters<typeof WebFetchTool>) {
  const info = yield* WebFetchTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

const failureMessage = Effect.fn("WebFetchSSRFTest.failureMessage")(function* (
  args: Tool.InferParameters<typeof WebFetchTool>,
) {
  const exit = yield* exec(args).pipe(Effect.exit)
  if (Exit.isSuccess(exit)) throw new Error(`expected ${args.url} to be rejected`)
  const failure = Cause.squash(exit.cause)
  return failure instanceof Error ? failure.message : String(failure)
})

describe("tool.webfetch ssrf guard", () => {
  it.instance("rejects loopback, private, and reserved hosts before any request", () =>
    Effect.gen(function* () {
      reset()
      const urls = [
        "http://127.0.0.1:8080/admin",
        "http://localhost/admin",
        "http://api.localhost/admin",
        "http://intranet.local/admin",
        "http://10.1.2.3/",
        "http://172.16.9.9/",
        "http://172.31.255.255/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data",
        "http://100.64.0.1/",
        "http://0.0.0.0/",
        "http://[::1]/",
        "http://[::]/",
        "http://[fc00::1]/",
        "http://[fe80::1]/",
        "http://[::ffff:10.0.0.1]/",
        "http://[::127.0.0.1]/",
        "http://[::169.254.169.254]/",
        "http://169.254.169.254./",
        "http://127.0.0.1./admin",
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
        expect(yield* failureMessage({ url, format: "text" })).toContain("Refusing to fetch private host")
      }
      expect(requests).toEqual([])
    }),
  )

  it.instance("rejects domains whose resolution reaches private or reserved space", () =>
    Effect.gen(function* () {
      reset()
      resolve = () => Promise.resolve([{ address: "127.0.0.1" }])
      expect(yield* failureMessage({ url: "http://rebind.example.com/", format: "text" })).toContain(
        "Refusing to fetch private host: rebind.example.com resolves to 127.0.0.1",
      )
      resolve = () => Promise.resolve([{ address: "93.184.216.34" }, { address: "10.0.0.1" }])
      expect(yield* failureMessage({ url: "http://mixed.example.com/", format: "text" })).toContain(
        "Refusing to fetch private host: mixed.example.com resolves to 10.0.0.1",
      )
      resolve = () => Promise.resolve([{ address: "::ffff:169.254.169.254" }])
      expect(yield* failureMessage({ url: "http://v6.example.com/", format: "text" })).toContain(
        "Refusing to fetch private host: v6.example.com resolves to ::ffff:169.254.169.254",
      )
      expect(requests).toEqual([])
    }),
  )

  it.instance("rejects domains when resolution fails or returns nothing (fail-closed)", () =>
    Effect.gen(function* () {
      reset()
      resolve = () => Promise.reject(new Error("ENOTFOUND"))
      expect(yield* failureMessage({ url: "http://missing.example.com/", format: "text" })).toContain(
        "Refusing to fetch unresolvable host",
      )
      resolve = () => Promise.resolve([])
      expect(yield* failureMessage({ url: "http://empty.example.com/", format: "text" })).toContain(
        "Refusing to fetch unresolvable host",
      )
      expect(requests).toEqual([])
    }),
  )

  it.instance("rejects non-http schemes", () =>
    Effect.gen(function* () {
      reset()
      expect(yield* failureMessage({ url: "file:///etc/passwd", format: "text" })).toContain("URL must start with http://")
      expect(yield* failureMessage({ url: "ftp://example.com/file", format: "text" })).toContain("URL must start with http://")
      expect(requests).toEqual([])
    }),
  )

  it.instance("refuses redirects that target private hosts", () =>
    Effect.gen(function* () {
      reset()
      respond = (url) =>
        url.pathname === "/redirect"
          ? new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
          : new Response("ok", { headers: { "content-type": "text/plain" } })

      expect(yield* failureMessage({ url: "https://example.com/redirect", format: "text" })).toContain("Refusing to fetch private host")
      expect(requests).toEqual(["https://example.com/redirect"])
    }),
  )

  it.instance("re-validates DNS resolution on every redirect hop", () =>
    Effect.gen(function* () {
      reset()
      respond = (url) =>
        url.pathname === "/redirect"
          ? new Response("", { status: 302, headers: { location: "http://rebind.example.com/target" } })
          : new Response("ok", { headers: { "content-type": "text/plain" } })
      const resolvedHosts: string[] = []
      resolve = (host) => {
        resolvedHosts.push(host)
        return Promise.resolve([{ address: host.startsWith("rebind.") ? "127.0.0.1" : "93.184.216.34" }])
      }

      expect(yield* failureMessage({ url: "https://example.com/redirect", format: "text" })).toContain(
        "Refusing to fetch private host: rebind.example.com resolves to 127.0.0.1",
      )
      expect(requests).toEqual(["https://example.com/redirect"])
      // The resolver was consulted for the redirect target before the second hop
      expect(resolvedHosts).toEqual(["example.com", "rebind.example.com"])
    }),
  )

  it.instance("follows redirects between public hosts", () =>
    Effect.gen(function* () {
      reset()
      respond = (url) =>
        url.pathname === "/redirect"
          ? new Response("", { status: 302, headers: { location: "https://other.example.com/target" } })
          : new Response("redirected", { headers: { "content-type": "text/plain" } })

      const result = yield* exec({ url: "https://example.com/redirect", format: "text" })
      expect(result.output).toBe("redirected")
      expect(requests).toEqual(["https://example.com/redirect", "https://other.example.com/target"])
    }),
  )

  it.instance("caps redirect hops", () =>
    Effect.gen(function* () {
      reset()
      respond = (url) =>
        url.pathname === "/final"
          ? new Response("done", { headers: { "content-type": "text/plain" } })
          : new Response("", { status: 302, headers: { location: "/hop" } })
      expect(yield* failureMessage({ url: "https://example.com/start", format: "text" })).toContain("Too many redirects")
      expect(requests).toHaveLength(6)
    }),
  )
})

describe("tool.webfetch connection-pinned DNS validation", () => {
  itPinned.instance("invokes the injected resolver when the request executes (pinning proof)", () =>
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

      const exit = yield* exec({ url: "http://pinned.example.com/", format: "text", timeout: 1 }).pipe(Effect.exit)
      // Pre-flight is the only other caller: a second invocation means the actual
      // fetch resolved DNS through the injected (validated) resolver.
      expect(calls.length).toBeGreaterThanOrEqual(2)
      expect(calls.every((host) => host === "pinned.example.com")).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause)
        expect(failure instanceof Error ? failure.message : String(failure)).not.toContain("Refusing to fetch")
      }
    }),
  )

  itPinned.instance("refuses a rebound hostname that only turns private at connect time", () =>
    Effect.gen(function* () {
      reset()
      const answers = [["93.184.216.34"], ["169.254.169.254"]]
      let n = 0
      resolve = () => Promise.resolve(answers[Math.min(n++, 1)].map((address) => ({ address })))

      expect(yield* failureMessage({ url: "http://rebind.example.com/", format: "text", timeout: 2 })).toContain(
        "Refusing to fetch private host: rebind.example.com resolves to 169.254.169.254",
      )
      expect(n).toBeGreaterThanOrEqual(2)
    }),
  )

  itPinned.instance("fails closed when connect-time resolution returns nothing", () =>
    Effect.gen(function* () {
      reset()
      const answers = [["93.184.216.34"], []]
      let n = 0
      resolve = () => Promise.resolve(answers[Math.min(n++, 1)].map((address) => ({ address })))

      expect(yield* failureMessage({ url: "http://empty.example.com/", format: "text", timeout: 2 })).toContain(
        "Refusing to fetch unresolvable host: empty.example.com",
      )
      expect(n).toBeGreaterThanOrEqual(2)
    }),
  )

  itPinned.instance("refuses a mixed public and private answer set at connect time", () =>
    Effect.gen(function* () {
      reset()
      const answers = [["93.184.216.34"], ["93.184.216.34", "10.0.0.1"]]
      let n = 0
      resolve = () => Promise.resolve(answers[Math.min(n++, 1)].map((address) => ({ address })))

      expect(yield* failureMessage({ url: "http://mixed.example.com/", format: "text", timeout: 2 })).toContain(
        "Refusing to fetch private host: mixed.example.com resolves to 10.0.0.1",
      )
      expect(n).toBeGreaterThanOrEqual(2)
    }),
  )
})
