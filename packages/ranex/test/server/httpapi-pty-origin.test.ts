import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Server } from "../../src/server/server"
import { PtyPaths } from "../../src/server/routes/instance/httpapi/groups/pty"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { Config, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Pty } from "@ranex/core/pty"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await resetDatabase()
      }),
    )
  }),
)

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const effectIt = testEffect(
  Layer.mergeAll(
    testStateLayer,
    layerWebSocketConstructorGlobal,
    servedRoutes.pipe(
      Layer.provide(layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

const directoryHeader = (dir: string) => HttpClientRequest.setHeader("x-opencode-directory", dir)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// The guard returns 403 before the WebSocket upgrade, so plain requests assert it.
;(process.platform === "win32" ? describe.skip : describe)("pty connect origin guard", () => {
  effectIt.live("rejects ticketless connects with a disallowed origin before upgrade", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
      const created = yield* HttpClientRequest.post(PtyPaths.create).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ command: "/bin/cat", title: "origin-guard" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(created.status).toBe(200)
      const info = yield* Schema.decodeUnknownEffect(Pty.Info)(yield* created.json)

      const evil = yield* HttpClientRequest.get(PtyPaths.connect.replace(":ptyID", info.id)).pipe(
        HttpClientRequest.setHeaders({ origin: "https://evil.example" }),
        HttpClient.execute,
      )
      expect(evil.status).toBe(403)

      const evilTicketed = yield* HttpClientRequest.get(
        `${PtyPaths.connect.replace(":ptyID", info.id)}?ticket=bogus`,
      ).pipe(
        HttpClientRequest.setHeaders({ origin: "https://evil.example" }),
        HttpClient.execute,
      )
      expect(evilTicketed.status).toBe(403)

      const removed = yield* HttpClientRequest.delete(PtyPaths.remove.replace(":ptyID", info.id)).pipe(
        directoryHeader(dir),
        HttpClient.execute,
      )
      expect(removed.status).toBe(200)
    }),
    30_000,
  )
})
