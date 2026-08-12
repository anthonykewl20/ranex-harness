import { Effect, Schema } from "effect"

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
}) {}

export function toApiError(error: unknown): ApiError {
  if (typeof error === "object" && error !== null && "status" in error && "message" in error) {
    return new ApiError({
      message: String((error as { message: unknown }).message),
      ...(typeof (error as { status: unknown }).status === "number"
        ? { status: (error as { status: number }).status }
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
      return Effect.sleep("60 seconds").pipe(Effect.flatMap(attempt))
    }),
  )
}
