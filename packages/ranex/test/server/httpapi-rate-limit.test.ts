import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import { ServerAuthorization, serverAuthorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"

const Api = HttpApi.make("test-rate-limit").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("probe", "/probe", {
        success: Schema.String,
      }),
    )
    .middleware(ServerAuthorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) => handlers.handle("probe", () => Effect.succeed("ok")))

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(serverAuthorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const secretLayer = ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "ranex" })
const itSecret = testEffect(apiLayer.pipe(Layer.provide(secretLayer)))

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""

const badProbe = HttpClientRequest.get("/probe").pipe(
  HttpClientRequest.setHeader("authorization", basic("ranex", "wrong")),
  HttpClient.execute,
)

const goodProbe = HttpClientRequest.get("/probe").pipe(
  HttpClientRequest.setHeader("authorization", basic("ranex", "secret")),
  HttpClient.execute,
)

// The layerTest server listens on loopback, so every request shares one client IP.
describe("auth failure rate limiting", () => {
  beforeEach(() => {
    ServerAuth.resetAuthFailures()
  })

  afterEach(() => {
    ServerAuth.resetAuthFailures()
  })

  itSecret.live("blocks invalid credentials after five failed authentications, serves valid ones", () =>
    Effect.gen(function* () {
      const failures = yield* Effect.all([badProbe, badProbe, badProbe, badProbe, badProbe], {
        concurrency: "unbounded",
      })
      for (const response of failures) expect(response.status).toBe(401)

      const blocked = yield* badProbe
      expect(blocked.status).toBe(429)
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0)

      // The lockout throttles brute force, not legitimate clients: valid
      // credentials from the same (possibly NAT-shared) IP authenticate.
      const served = yield* goodProbe
      expect(served.status).toBe(200)
      expect(yield* served.json).toBe("ok")

      // Invalid credentials from the same IP stay throttled.
      const stillBlocked = yield* badProbe
      expect(stillBlocked.status).toBe(429)
    }),
  )

  itSecret.live("resets the failure window after a successful authentication", () =>
    Effect.gen(function* () {
      const failures = yield* Effect.all([badProbe, badProbe, badProbe, badProbe], {
        concurrency: "unbounded",
      })
      for (const response of failures) expect(response.status).toBe(401)

      const success = yield* goodProbe
      expect(success.status).toBe(200)

      const afterReset = yield* Effect.all([badProbe, badProbe, badProbe, badProbe, badProbe], {
        concurrency: "unbounded",
      })
      for (const response of afterReset) expect(response.status).toBe(401)

      const blocked = yield* badProbe
      expect(blocked.status).toBe(429)
    }),
  )

  itSecret.live("does not rate-charge valid Basic credentials carrying garbage query tokens", () =>
    Effect.gen(function* () {
      // Header credentials are evaluated first: garbage auth_token values
      // riding along with a valid Basic header record no failure, so six of
      // them must not lock the client out.
      const probes = yield* Effect.all(
        Array.from({ length: 6 }, () =>
          HttpClientRequest.get("/probe?auth_token=garbage").pipe(
            HttpClientRequest.setHeader("authorization", basic("ranex", "secret")),
            HttpClient.execute,
          ),
        ),
        { concurrency: "unbounded" },
      )
      for (const response of probes) expect(response.status).toBe(200)

      // No failures were charged: the next bad probe is a fresh 401, not 429.
      const after = yield* badProbe
      expect(after.status).toBe(401)
    }),
  )

  itSecret.live("jitters the advertised Retry-After around the exact lockout remaining", () =>
    Effect.gen(function* () {
      const failures = yield* Effect.all([badProbe, badProbe, badProbe, badProbe, badProbe], {
        concurrency: "unbounded",
      })
      for (const response of failures) expect(response.status).toBe(401)

      const blocked = yield* badProbe
      expect(blocked.status).toBe(429)
      // The internal remaining is the 15-minute window minus the real milliseconds
      // elapsed since the fifth failure; the advertised value must stay within
      // ±20% of that (plus rounding slack), never below one second.
      const advertised = Number(blocked.headers["retry-after"])
      expect(advertised).toBeGreaterThanOrEqual(Math.floor(0.8 * 890))
      expect(advertised).toBeLessThanOrEqual(Math.ceil(1.2 * 900))
    }),
  )
})

// Synthetic-clock unit tests for the exponential lockout escalation; the
// HTTP-level behavior above covers the response shape.
describe("auth failure lockout escalation", () => {
  beforeEach(() => {
    ServerAuth.resetAuthFailures()
  })

  afterEach(() => {
    ServerAuth.resetAuthFailures()
  })

  const lockoutAfterFiveFails = (key: string, at: number) => {
    for (let i = 0; i < 5; i++) ServerAuth.recordAuthFailure(key, at + i * 1000)
    return ServerAuth.authRateLimited(key, at + 10_000)
  }

  test("doubles the lockout duration for each consecutive lockout", () => {
    const key = "escalation-client"
    const t0 = 1_700_000_000_000

    const first = lockoutAfterFiveFails(key, t0)
    expect(first.blocked).toBe(true)
    // Base window: the lockout started at the fifth failure (t0+4s) and lasts
    // 15 minutes; 10s into the burst, 894s remain.
    expect(first.retryAfterSeconds).toBe(894)

    // The first lockout expires and the five failures age out with it.
    const afterFirst = t0 + 4_000 + 15 * 60_000 + 1_000
    expect(ServerAuth.authRateLimited(key, afterFirst).blocked).toBe(false)

    const second = lockoutAfterFiveFails(key, afterFirst)
    expect(second.blocked).toBe(true)
    // Doubled: a 30-minute lockout with the same 6s of burst offset.
    expect(second.retryAfterSeconds).toBe(2 * 900 - 6)
    expect(second.retryAfterSeconds / first.retryAfterSeconds).toBeGreaterThanOrEqual(1.9)
  })

  test("caps the escalated lockout at 24 hours", () => {
    const key = "cap-client"
    let at = 1_700_000_000_000
    let lastRemaining = 0
    for (let lockout = 0; lockout < 8; lockout++) {
      const limited = lockoutAfterFiveFails(key, at)
      expect(limited.blocked).toBe(true)
      lastRemaining = limited.retryAfterSeconds
      // Jump far enough past this lockout that every recorded failure has aged out.
      at += 24 * 60 * 60_000 + 10_000
    }
    // 15m * 2^7 would be 32h; the cap keeps the eighth lockout at 24h.
    expect(lastRemaining).toBeGreaterThan(16 * 60 * 60)
    expect(lastRemaining).toBeLessThanOrEqual(24 * 60 * 60)
  })

  test("a successful authentication resets the escalation", () => {
    const key = "reset-client"
    const t0 = 1_700_000_000_000

    const first = lockoutAfterFiveFails(key, t0)
    expect(first.blocked).toBe(true)
    expect(first.retryAfterSeconds).toBe(894)

    ServerAuth.clearAuthFailures(key)

    const afterReset = lockoutAfterFiveFails(key, t0 + 60_000)
    expect(afterReset.blocked).toBe(true)
    // The base window again, not a doubled lockout.
    expect(afterReset.retryAfterSeconds).toBe(894)
  })

  test("listener realms key failure budgets per configured credentials", () => {
    const realm = ServerAuth.authRealm({ password: Option.some("secret"), username: "ranex" })
    // Same credentials → same realm (one shared budget per account).
    expect(ServerAuth.authRealm({ password: Option.some("secret"), username: "ranex" })).toBe(realm)
    const otherRealm = ServerAuth.authRealm({ password: Option.some("other-secret"), username: "ranex" })
    expect(otherRealm).not.toBe(realm)

    // Same client address, separate budgets per realm: locking one listener
    // never locks an independent listener in the same process.
    const client = "10.0.0.1"
    for (let i = 0; i < 5; i++) ServerAuth.recordAuthFailure(`${realm}:${client}`)
    expect(ServerAuth.authRateLimited(`${realm}:${client}`).blocked).toBe(true)
    expect(ServerAuth.authRateLimited(`${otherRealm}:${client}`).blocked).toBe(false)
  })
})
