import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import {
  Authorization,
  authorizationLayer,
  ServerAuthorization,
  serverAuthorizationLayer,
} from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"

const Api = HttpApi.make("test-origin-guard").add(
  HttpApiGroup.make("test")
    .add(HttpApiEndpoint.get("probe", "/probe", { success: Schema.String }))
    .middleware(Authorization),
)

const ServerApi = HttpApi.make("test-server-origin-guard").add(
  HttpApiGroup.make("test.v2")
    .add(HttpApiEndpoint.get("probe", "/api/probe", { success: Schema.String }))
    .middleware(ServerAuthorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) =>
  handlers.handle("probe", () => Effect.succeed("ok")),
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

const it = testEffect(apiLayer.pipe(Layer.provide(noAuthLayer)))
const itSecret = testEffect(apiLayer.pipe(Layer.provide(secretLayer)))
const itV2Secret = testEffect(v2ApiLayer.pipe(Layer.provide(secretLayer)))

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""

const getProbe = (path: string, headers?: Record<string, string>) =>
  HttpClientRequest.get(path).pipe(
    headers ? HttpClientRequest.setHeaders(headers) : (request) => request,
    HttpClient.execute,
  )

describe("HttpApi origin and host guard", () => {
  itSecret.live("rejects a matching evil Origin and Host even with valid credentials", () =>
    Effect.gen(function* () {
      const response = yield* getProbe("/probe", {
        host: "evil.example:4096",
        origin: "http://evil.example:4096",
        authorization: basic("ranex", "secret"),
      })

      expect(response.status).toBe(403)
    }),
  )

  itSecret.live("rejects a spoofed non-IP Host without Origin", () =>
    Effect.gen(function* () {
      const response = yield* getProbe("/probe", { host: "evil.example:4096", authorization: basic("ranex", "secret") })

      expect(response.status).toBe(403)
    }),
  )

  itSecret.live("allows localhost Origin with valid credentials", () =>
    Effect.gen(function* () {
      const response = yield* getProbe("/probe", {
        origin: "http://localhost:3000",
        authorization: basic("ranex", "secret"),
      })

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe("ok")
    }),
  )

  itSecret.live("allows no-Origin requests with valid credentials", () =>
    Effect.gen(function* () {
      const response = yield* getProbe("/probe", { authorization: basic("ranex", "secret") })

      expect(response.status).toBe(200)
    }),
  )

  it.live("enforces the guard even when no password is configured", () =>
    Effect.gen(function* () {
      const [evil, ok] = yield* Effect.all(
        [
          getProbe("/probe", { host: "evil.example:4096", origin: "http://evil.example:4096" }),
          getProbe("/probe"),
        ],
        { concurrency: "unbounded" },
      )

      expect(evil.status).toBe(403)
      expect(ok.status).toBe(200)
    }),
  )

  itV2Secret.live("v2 server middleware rejects a matching evil Origin and Host", () =>
    Effect.gen(function* () {
      const response = yield* getProbe("/api/probe", {
        host: "evil.example:4096",
        origin: "http://evil.example:4096",
        authorization: basic("ranex", "secret"),
      })

      expect(response.status).toBe(403)
    }),
  )

  itV2Secret.live("v2 server middleware allows localhost Origin with valid credentials", () =>
    Effect.gen(function* () {
      const response = yield* getProbe("/api/probe", {
        origin: "http://localhost:3000",
        authorization: basic("ranex", "secret"),
      })

      expect(response.status).toBe(200)
    }),
  )
})
