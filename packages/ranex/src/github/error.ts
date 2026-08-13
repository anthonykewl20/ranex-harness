import { Duration, Effect, Schema } from "effect"

export class GitHubError extends Schema.TaggedErrorClass<GitHubError>()("GitHub.Error", {
  message: Schema.String,
}) {}

export class AuthMissing extends Schema.TaggedErrorClass<AuthMissing>()("GitHub.AuthMissing", {
  message: Schema.String,
}) {}

export class RepoNotResolved extends Schema.TaggedErrorClass<RepoNotResolved>()("GitHub.RepoNotResolved", {
  message: Schema.String,
}) {}

export class ApiError extends Schema.TaggedErrorClass<ApiError>()("GitHub.ApiError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  headers: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
  ),
}) {
  constructor(props: { message: string; status?: number; headers?: Record<string, string | number> }) {
    super({
      ...props,
      ...(props.headers
        ? {
            headers: Object.fromEntries(
              Object.entries(props.headers).map(([key, value]) => [key.toLowerCase(), value]),
            ),
          }
        : {}),
    })
  }
}

export function toApiError(error: unknown): ApiError {
  if (typeof error === "object" && error !== null && "status" in error && "message" in error) {
    const response = "response" in error ? error.response : undefined
    const headers =
      typeof response === "object" && response !== null && "headers" in response
        ? response.headers
        : undefined
    return new ApiError({
      message: String((error as { message: unknown }).message),
      ...(typeof (error as { status: unknown }).status === "number"
        ? { status: (error as { status: number }).status }
        : {}),
      ...(typeof headers === "object" && headers !== null
        ? {
            headers: Object.fromEntries(
              Object.entries(headers).filter(
                (entry): entry is [string, string | number] =>
                  typeof entry[1] === "string" || typeof entry[1] === "number",
              ),
            ),
          }
        : {}),
    })
  }
  return new ApiError({ message: error instanceof Error ? error.message : String(error) })
}

export function isRateLimited(error: ApiError): boolean {
  if (error.status === 429) return true
  if (error.status === 403 && error.message.toLowerCase().includes("rate limit")) return true
  return false
}

export function withRateLimitRetry<T>(fn: () => Promise<T>): Effect.Effect<T, ApiError> {
  const attempt = () => Effect.tryPromise({ try: fn, catch: toApiError })
  return attempt().pipe(
    Effect.catch((error) => {
      if (!isRateLimited(error)) return Effect.fail(error)
      const retryAfter = Number(error.headers?.["retry-after"])
      const reset = Number(error.headers?.["x-ratelimit-reset"])
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : Number.isFinite(reset) && reset > 0
          ? Math.max(0, reset - Date.now() / 1_000)
          : 60
      const delay = Math.min(seconds, 60)
      return Effect.sleep(Duration.seconds(delay)).pipe(Effect.flatMap(attempt))
    }),
  )
}
