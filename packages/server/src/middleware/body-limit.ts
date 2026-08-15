import { Cause, Effect, FileSystem } from "effect"
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

export const DEFAULT_MAX_BODY_BYTES = 52_428_800

function maxBodyBytes() {
  const raw = Number(process.env.RANEX_MAX_BODY_BYTES)
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_BODY_BYTES
}

// The request body stream itself cannot be replaced mid-flight
// (`HttpServerRequest.modify` only patches url/headers/remoteAddress), so the
// cap has two halves: a content-length pre-check that rejects oversized
// declared bodies with 413 before any read, and the platform
// `HttpIncomingMessage.MaxBodySize` fiber reference, which the Node server
// adapters honor for every buffered body read (text/json/arrayBuffer) and for
// multipart totals. The readers destroy the request stream and fail with
// "maxBytes exceeded" once the cap is crossed, which covers chunked uploads
// sent without a content-length (see SECURITY.md). The limit is read once per
// layer construction so RANEX_MAX_BODY_BYTES overrides apply without
// restarting in-flight servers built from the same layer.
const exceedsBodyLimit = (value: unknown): boolean => {
  const reason = (value as { reason?: { _tag?: string; cause?: unknown } } | undefined)?.reason
  // Node body readers: HttpServerError -> RequestParseError with cause Error("maxBytes exceeded")
  if (reason?._tag === "RequestParseError") {
    return (reason.cause as Error | undefined)?.message === "maxBytes exceeded"
  }
  // Multipart totals: MultipartError with reason BodyTooLarge
  return reason?._tag === "BodyTooLarge"
}

// Recover to 413 only when EVERY failure reason in the cause is a body-limit
// failure: a cause mixing "maxBytes exceeded" with unrelated co-failures
// (handler errors, defects, interruption) must propagate untouched, or the
// 413 would swallow the co-failure's own semantics.
const causeExceedsBodyLimit = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) =>
    reason._tag === "Fail" ? exceedsBodyLimit(reason.error) : reason._tag === "Die" && exceedsBodyLimit(reason.defect),
  )

export const bodyLimitLayer = HttpRouter.middleware()(
  Effect.gen(function* () {
    const limit = maxBodyBytes()
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const contentLength = Number(request.headers["content-length"])
        if (Number.isInteger(contentLength) && contentLength > limit) {
          return HttpServerResponse.jsonUnsafe({ error: "Payload Too Large" }, { status: 413 })
        }
        return yield* effect.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(limit)),
          Effect.catchCauseIf(causeExceedsBodyLimit, () =>
            Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "Payload Too Large" }, { status: 413 })),
          ),
        )
      })
  }),
).layer
