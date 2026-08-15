import { NodeHttpServer } from "@effect/platform-node"
import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "@ranex/server/auth"
import { TicketHandler } from "@ranex/server/handlers/ticket"
import { TicketGroup } from "@ranex/server/ticket"
import { ServerAuthorization, serverAuthorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"

// Mounts only the ticket group plus probe endpoints behind the same v2
// authorization middleware that protects /api/ticket in production. The
// ticket group carries its Authorization middleware on itself. The event and
// pty-connect probes mirror the v2 URL-auth route shapes: /api/event and
// /api/pty/:ptyID/connect are the endpoints whose channel cannot carry
// headers, so default url-auth tickets must work there and nowhere else.
const TicketApi = HttpApi.make("test-ticket")
  .add(
    HttpApiGroup.make("test.probe")
      .add(
        HttpApiEndpoint.get("probe", "/probe", {
          success: Schema.String,
        }),
      )
      .middleware(ServerAuthorization),
  )
  .add(
    HttpApiGroup.make("test.event")
      .add(
        HttpApiEndpoint.get("event", "/api/event", {
          success: Schema.String,
        }),
      )
      .middleware(ServerAuthorization),
  )
  .add(
    HttpApiGroup.make("test.pty")
      .add(
        HttpApiEndpoint.get("connect", "/api/pty/:ptyID/connect", {
          params: { ptyID: Schema.String },
          success: Schema.String,
        }),
      )
      .middleware(ServerAuthorization),
  )
  .add(TicketGroup)

const probeHandlers = HttpApiBuilder.group(TicketApi, "test.probe", (handlers) =>
  handlers.handle("probe", () => Effect.succeed("ok")),
)

const eventHandlers = HttpApiBuilder.group(TicketApi, "test.event", (handlers) =>
  handlers.handle("event", () => Effect.succeed("ok")),
)

const ptyHandlers = HttpApiBuilder.group(TicketApi, "test.pty", (handlers) =>
  handlers.handle("connect", () => Effect.succeed("ok")),
)

// TicketHandler is built against the v2 server Api; its group service is
// tagged with that Api's id, which this test Api addresses nominally
// differently. The runtime key is the group itself and matches either way.
const ticketApiRoutes = HttpApiBuilder.layer(TicketApi).pipe(
  Layer.provide([
    TicketHandler as unknown as Layer.Layer<never>,
    probeHandlers,
    eventHandlers,
    ptyHandlers,
  ]),
  Layer.provide(serverAuthorizationLayer),
) as unknown as Layer.Layer<HttpRouter.HttpRouter>

const apiLayer = HttpRouter.serve(ticketApiRoutes, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
)

const secretLayer = ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "ranex" })
const itSecret = testEffect(apiLayer.pipe(Layer.provide(secretLayer)))

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""

// Tickets are keyed by the process-local random secret, so minting takes no
// credentials; over-HTTP minting is covered via mintViaApi below.
const mint = (nowSeconds = Math.floor(Date.now() / 1000), scope: ServerAuth.TicketScope = "url-auth") =>
  ServerAuth.mintTicket(nowSeconds, scope).ticket

const mintViaApi = HttpClientRequest.post("/api/ticket").pipe(
  HttpClientRequest.setHeader("authorization", basic("ranex", "secret")),
  HttpClient.execute,
)

describe("URL auth tickets", () => {
  beforeEach(() => {
    ServerAuth.resetAuthFailures()
    // Ticket secret rotation from other tests (or files) must not leak in.
    ServerAuth.resetTicketSecret()
  })

  itSecret.live("mints a default url-auth ticket accepted on the event stream route and replayable within its TTL", () =>
    Effect.gen(function* () {
      const response = yield* mintViaApi

      expect(response.status).toBe(200)
      const body = (yield* response.json) as { ticket: string; expiresAt: string }
      expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
      expect(Date.parse(body.expiresAt)).toBeLessThanOrEqual(Date.now() + (ServerAuth.TICKET_TTL_SECONDS + 1) * 1000)

      // SSE reconnect semantics: the same ticket is deliberately reusable on
      // in-scope endpoints until it expires.
      const event = yield* HttpClient.get(`/api/event?auth_token=${encodeURIComponent(body.ticket)}`)
      expect(event.status).toBe(200)
      expect(yield* event.json).toBe("ok")

      const replay = yield* HttpClient.get(`/api/event?auth_token=${encodeURIComponent(body.ticket)}`)
      expect(replay.status).toBe(200)

      const pty = yield* HttpClient.get(`/api/pty/some-pty/connect?auth_token=${encodeURIComponent(body.ticket)}`)
      expect(pty.status).toBe(200)
    }),
  )

  itSecret.live("rejects default url-auth tickets on endpoints outside their scope", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(mint())}`)

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain('error="invalid_request"')
    }),
  )

  itSecret.live("mints full-API tickets on explicit scope request, accepted everywhere", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/api/ticket?scope=api").pipe(
        HttpClientRequest.setHeader("authorization", basic("ranex", "secret")),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      const body = (yield* response.json) as { ticket: string; expiresAt: string }

      const probe = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(body.ticket)}`)
      expect(probe.status).toBe(200)
      expect(yield* probe.json).toBe("ok")

      const event = yield* HttpClient.get(`/api/event?auth_token=${encodeURIComponent(body.ticket)}`)
      expect(event.status).toBe(200)
    }),
  )

  itSecret.live("rejects unknown mint scopes", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post("/api/ticket?scope=nonsense").pipe(
        HttpClientRequest.setHeader("authorization", basic("ranex", "secret")),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  itSecret.live("requires Basic credentials in the Authorization header to mint", () =>
    Effect.gen(function* () {
      const [missing, wrong] = yield* Effect.all(
        [
          HttpClientRequest.post("/api/ticket").pipe(HttpClient.execute),
          HttpClientRequest.post("/api/ticket").pipe(
            HttpClientRequest.setHeader("authorization", basic("ranex", "wrong")),
            HttpClient.execute,
          ),
        ],
        { concurrency: "unbounded" },
      )

      expect(missing.status).toBe(401)
      expect(wrong.status).toBe(401)
    }),
  )

  itSecret.live("rejects expired tickets", () =>
    Effect.gen(function* () {
      const expired = mint(Math.floor(Date.now() / 1000) - ServerAuth.TICKET_TTL_SECONDS)
      const response = yield* HttpClient.get(`/api/event?auth_token=${encodeURIComponent(expired)}`)

      expect(response.status).toBe(401)
    }),
  )

  itSecret.live("keys tickets with a random per-process secret, not the Basic password", () =>
    Effect.gen(function* () {
      // A minted ticket verifies in-process, and its key is unrelated to the
      // Basic password: minting with any legacy password argument produces
      // the same verification outcome, so a leaked ticket is not an offline
      // password-guessing verifier.
      const ticket = mint()
      expect(ServerAuth.verifyTicket(ticket)).toBe("url-auth")
      expect(ServerAuth.verifyTicket(mint(Math.floor(Date.now() / 1000), "api"))).toBe("api")

      const response = yield* HttpClient.get(`/api/event?auth_token=${encodeURIComponent(ticket)}`)
      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("invalidates every outstanding ticket when the process restarts", () =>
    Effect.gen(function* () {
      const before = mint()
      expect(ServerAuth.verifyTicket(before)).toBe("url-auth")

      // Process restart: the ephemeral ticket secret dies with the process.
      ServerAuth.resetTicketSecret()

      expect(ServerAuth.verifyTicket(before)).toBeUndefined()
      const response = yield* HttpClient.get(`/api/event?auth_token=${encodeURIComponent(before)}`)
      expect(response.status).toBe(401)

      // A freshly minted ticket verifies against the new secret.
      const after = mint()
      expect(ServerAuth.verifyTicket(after)).toBe("url-auth")
      const fresh = yield* HttpClient.get(`/api/event?auth_token=${encodeURIComponent(after)}`)
      expect(fresh.status).toBe(200)
    }),
  )

  itSecret.live("never accepts URL tickets on the mint endpoint, even with api scope", () =>
    Effect.gen(function* () {
      // An api-scope ticket satisfies every other endpoint's query channel,
      // but the mint endpoint takes actual Basic header credentials only: a
      // ticket must not be able to mint its own replacement.
      const apiTicket = mint(Math.floor(Date.now() / 1000), "api")
      const ticketMint = yield* HttpClientRequest.post(
        `/api/ticket?scope=api&auth_token=${encodeURIComponent(apiTicket)}`,
      ).pipe(HttpClient.execute)

      expect(ticketMint.status).toBe(401)

      // Minting with real Basic credentials still works, and the resulting
      // ticket is accepted on in-scope endpoints as usual.
      const minted = yield* mintViaApi
      expect(minted.status).toBe(200)
      const body = (yield* minted.json) as { ticket: string }
      const event = yield* HttpClient.get(`/api/event?auth_token=${encodeURIComponent(body.ticket)}`)
      expect(event.status).toBe(200)
    }),
  )

  itSecret.live("rejects tampered tickets", () =>
    Effect.gen(function* () {
      const tampered = `${mint().slice(0, -2)}xx`
      const response = yield* HttpClient.get(`/api/event?auth_token=${encodeURIComponent(tampered)}`)

      expect(response.status).toBe(401)
    }),
  )

  itSecret.live("rejects tickets minted in the legacy scope-less format", () =>
    Effect.gen(function* () {
      // Pre-scoping tickets carried only the expiry in the payload; a legacy
      // ticket (wrong MAC key AND legacy payload shape) must not verify
      // anymore.
      const payload = Buffer.from(String(Math.floor(Date.now() / 1000) + ServerAuth.TICKET_TTL_SECONDS)).toString(
        "base64url",
      )
      const { createHmac } = yield* Effect.promise(() => import("node:crypto"))
      const mac = createHmac("sha256", "secret").update(payload).digest("base64url")

      const response = yield* HttpClient.get(`/api/event?auth_token=${encodeURIComponent(`${payload}.${mac}`)}`)

      expect(response.status).toBe(401)
    }),
  )

  itSecret.live("rejects Basic credentials in the URL", () =>
    Effect.gen(function* () {
      const token = Buffer.from("ranex:secret").toString("base64")
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(token)}`)

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain('error="invalid_request"')
      expect(response.headers["www-authenticate"] ?? "").toContain("Authorization header")
    }),
  )

  itSecret.live("rejects malformed auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/probe?auth_token=not-a-ticket")

      expect(response.status).toBe(401)
    }),
  )
})
