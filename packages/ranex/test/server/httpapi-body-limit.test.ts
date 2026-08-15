import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { bodyLimitLayer, DEFAULT_MAX_BODY_BYTES } from "@ranex/server/middleware/body-limit"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/unstable/http"
import { testEffect } from "../lib/effect"

// The middleware rejects on the content-length header before any body is
// read, so a Request whose declared length alone crosses the cap is enough;
// a raw web handler keeps the explicit header intact (HTTP clients recompute
// it from the actual body).
const handler = HttpRouter.toWebHandler(
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      yield* router.add("POST", "/upload", (request) =>
        request.text.pipe(Effect.map((text) => HttpServerResponse.text(`received ${text.length} bytes`))),
      )
    }),
  ).pipe(Layer.provide(bodyLimitLayer), Layer.provide(HttpServer.layerServices)),
  { disableLogger: true },
).handler

const it = testEffect(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))

const upload = (contentLength: string, body?: string) =>
  Effect.promise(() =>
    Promise.resolve(
      handler(
        new Request("http://localhost/upload", {
          method: "POST",
          headers: { "content-length": contentLength },
          body,
        }),
      ),
    ),
  )

describe("request body limit", () => {
  it.live("rejects requests whose content-length exceeds the default cap", () =>
    Effect.gen(function* () {
      const response = yield* upload(String(DEFAULT_MAX_BODY_BYTES + 1))

      expect(response.status).toBe(413)
    }),
  )

  it.live("allows requests under the cap", () =>
    Effect.gen(function* () {
      const response = yield* upload("8", "x".repeat(8))

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toBe("received 8 bytes")
    }),
  )

  test("defaults to a 50 MB cap", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(52_428_800)
  })
})

// Chunked uploads carry no content-length, so enforcement happens in the body
// readers themselves: the middleware installs the platform MaxBodySize fiber
// reference, and the Node server adapters abort the stream once the cap is
// crossed. These tests run against the real Node platform server because the
// in-process web handler does not route body reads through those adapters.
const capScoped = <R>(effect: Effect.Effect<void, unknown, R>) =>
  Effect.gen(function* () {
    const previous = process.env.RANEX_MAX_BODY_BYTES
    process.env.RANEX_MAX_BODY_BYTES = "1024"
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.RANEX_MAX_BODY_BYTES
        else process.env.RANEX_MAX_BODY_BYTES = previous
      }),
    )
    // bodyLimitLayer reads RANEX_MAX_BODY_BYTES at construction, so the route
    // layer must be built inside the override window.
    yield* HttpRouter.add("POST", "/upload", (request) =>
      request.text.pipe(Effect.map((text) => HttpServerResponse.text(`received ${text.length} bytes`))),
    ).pipe(Layer.provide(bodyLimitLayer), HttpRouter.serve, Layer.build)
    yield* effect
  })

// A stream body without a content-length makes the client send chunked.
const chunkedUpload = (bytes: number) =>
  HttpClientRequest.post("/upload").pipe(
    HttpClientRequest.setBody(
      HttpBody.stream(Stream.make(new TextEncoder().encode("x".repeat(bytes))), "application/octet-stream"),
    ),
    HttpClient.execute,
  )

describe("request body limit (chunked)", () => {
  it.live("aborts chunked uploads that cross the cap", () =>
    capScoped(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(chunkedUpload(4096))

        // The rejection is either the middleware's explicit 413 (the cause is
        // purely the body-limit failure) or the aborted connection the stream
        // destruction surfaces as a transport-level client error. Anything
        // else — a 200 whose body was fully read, a different status, or a
        // non-transport failure — is a regression.
        if (Exit.isSuccess(exit)) {
          expect(exit.value.status).toBe(413)
          return
        }
        expect(HttpClientError.isHttpClientError(Cause.squash(exit.cause))).toBe(true)
      }),
    ),
  )

  it.live("allows small chunked uploads under the cap", () =>
    capScoped(
      Effect.gen(function* () {
        const response = yield* chunkedUpload(8)

        expect(response.status).toBe(200)
        expect(yield* response.text).toBe("received 8 bytes")
      }),
    ),
  )
})
