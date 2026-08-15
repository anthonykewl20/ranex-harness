import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import {
  Authorization,
  authorizationLayer,
  ServerAuthorization,
  serverAuthorizationLayer,
} from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"

const Api = HttpApi.make("test-authorization").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("probe", "/probe", {
        success: Schema.String,
      }),
      HttpApiEndpoint.get("event", "/event", {
        success: Schema.String,
      }),
      HttpApiEndpoint.get("missing", "/missing", {
        success: Schema.String,
        error: HttpApiError.NotFound,
      }),
    )
    .middleware(Authorization),
)

const ServerApi = HttpApi.make("test-server-authorization").add(
  HttpApiGroup.make("test.v2")
    .add(
      HttpApiEndpoint.get("probe", "/api/probe", {
        success: Schema.String,
      }),
    )
    .middleware(ServerAuthorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) =>
  handlers
    .handle("probe", () => Effect.succeed("ok"))
    .handle("event", () => Effect.succeed("ok"))
    .handle("missing", () => Effect.fail(new HttpApiError.NotFound({}))),
)

const serverHandlers = HttpApiBuilder.group(ServerApi, "test.v2", (handlers) =>
  handlers.handle("probe", () => Effect.succeed("ok")),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(authorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const v2ApiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(ServerApi).pipe(Layer.provide(serverHandlers), Layer.provide(serverAuthorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const noAuthLayer = ServerAuth.Config.configLayer({ password: Option.none(), username: "ranex" })
const secretLayer = ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "ranex" })
const kitSecretLayer = ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "kit" })

const it = testEffect(apiLayer.pipe(Layer.provide(noAuthLayer)))
const itSecret = testEffect(apiLayer.pipe(Layer.provide(secretLayer)))
const itKitSecret = testEffect(apiLayer.pipe(Layer.provide(kitSecretLayer)))
const itV2Secret = testEffect(v2ApiLayer.pipe(Layer.provide(secretLayer)))

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""

// URL tickets are minted directly from the process-local secret; the endpoint
// roundtrip lives in httpapi-ticket.test.ts. The api scope keeps the generic
// channel tests path-independent; scope semantics get dedicated tests below.
const ticket = (nowSeconds = Math.floor(Date.now() / 1000)) => ServerAuth.mintTicket(nowSeconds, "api").ticket

const urlAuthTicket = () => ServerAuth.mintTicket().ticket

const getProbe = (headers?: Record<string, string>) =>
  HttpClientRequest.get("/probe").pipe(
    headers ? HttpClientRequest.setHeaders(headers) : (request) => request,
    HttpClient.execute,
  )

describe("HttpApi authorization middleware", () => {
  beforeEach(() => {
    ServerAuth.resetAuthFailures()
  })

  afterEach(() => {
    ServerAuth.resetAuthFailures()
  })
  it.live("allows requests when server password is not configured", () =>
    Effect.gen(function* () {
      const response = yield* getProbe()

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe("ok")
    }),
  )

  itSecret.live("requires configured password for basic auth", () =>
    Effect.gen(function* () {
      const [missing, badPassword, good] = yield* Effect.all(
        [
          getProbe(),
          getProbe({ authorization: basic("ranex", "wrong") }),
          getProbe({ authorization: basic("ranex", "secret") }),
        ],
        { concurrency: "unbounded" },
      )

      expect(missing.status).toBe(401)
      expect(missing.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(badPassword.status).toBe(401)
      expect(badPassword.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(good.status).toBe(200)
    }),
  )

  itKitSecret.live("respects configured basic auth username", () =>
    Effect.gen(function* () {
      const [defaultUser, configuredUser] = yield* Effect.all(
        [getProbe({ authorization: basic("ranex", "secret") }), getProbe({ authorization: basic("kit", "secret") })],
        { concurrency: "unbounded" },
      )

      expect(defaultUser.status).toBe(401)
      expect(configuredUser.status).toBe(200)
    }),
  )

  itSecret.live("accepts ticket query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(ticket())}`)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("accepts default url-auth tickets on the event stream route", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/event?auth_token=${encodeURIComponent(urlAuthTicket())}`)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("rejects url-auth tickets on endpoints outside their scope", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(urlAuthTicket())}`)

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain('error="invalid_request"')
    }),
  )

  itSecret.live("prefers valid Basic header credentials over garbage query tokens", () =>
    Effect.gen(function* () {
      // Repeated garbage tokens must never reject (or rate-charge) a client
      // holding valid Basic header credentials.
      const responses = yield* Effect.all(
        Array.from({ length: 6 }, () =>
          HttpClientRequest.get("/probe?auth_token=not-a-ticket").pipe(
            HttpClientRequest.setHeader("authorization", basic("ranex", "secret")),
            HttpClient.execute,
          ),
        ),
        { concurrency: "unbounded" },
      )

      for (const response of responses) expect(response.status).toBe(200)
    }),
  )

  itSecret.live("rejects invalid Basic header credentials even with a valid query ticket", () =>
    Effect.gen(function* () {
      // Header credentials take precedence: an invalid Basic header is the
      // failed credential of record and the ticket fallback does not apply.
      const response = yield* HttpClientRequest.get(`/probe?auth_token=${encodeURIComponent(ticket())}`).pipe(
        HttpClientRequest.setHeader("authorization", basic("ranex", "wrong")),
        HttpClient.execute,
      )

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain("Basic")
    }),
  )

  itSecret.live("preserves handler errors when basic auth succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/missing").pipe(
        HttpClientRequest.setHeader("authorization", basic("ranex", "secret")),
        HttpClient.execute,
      )

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("preserves handler errors when ticket query succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/missing?auth_token=${encodeURIComponent(ticket())}`)

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("rejects expired ticket query credentials", () =>
    Effect.gen(function* () {
      const expired = ticket(Math.floor(Date.now() / 1000) - ServerAuth.TICKET_TTL_SECONDS)
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(expired)}`)

      expect(response.status).toBe(401)
    }),
  )

  itSecret.live("rejects Basic credentials in the URL", () =>
    Effect.gen(function* () {
      const token = Buffer.from("ranex:secret").toString("base64")
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(token)}`)

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain('error="invalid_request"')
    }),
  )

  itSecret.live("rejects malformed auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/probe?auth_token=not-a-ticket")

      expect(response.status).toBe(401)
    }),
  )

  itV2Secret.live("returns bodyful v2 unauthorized errors", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/api/probe")
      const body = yield* response.json

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(body).toEqual({ _tag: "UnauthorizedError", message: "Authentication required" })
    }),
  )
})
