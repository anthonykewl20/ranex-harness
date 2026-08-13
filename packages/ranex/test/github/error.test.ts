import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { ApiError, isRateLimited, toApiError, withRateLimitRetry } from "../../src/github/error"
import { it } from "../lib/effect"

describe("github.error.toApiError", () => {
  test("converts octokit-style error with status and message", () => {
    const result = toApiError({
      status: 404,
      message: "Not Found",
      response: { headers: { "Retry-After": "5", ignored: true } },
    })

    expect(result).toBeInstanceOf(ApiError)
    expect(result.message).toBe("Not Found")
    expect(result.status).toBe(404)
    expect(result.headers).toEqual({ "retry-after": "5" })
  })

  test("converts error with message but no numeric status", () => {
    const result = toApiError({ status: "fail", message: "something broke" })

    expect(result).toBeInstanceOf(ApiError)
    expect(result.message).toBe("something broke")
    expect(result.status).toBeUndefined()
  })

  test("converts Error instance", () => {
    const result = toApiError(new Error("boom"))

    expect(result).toBeInstanceOf(ApiError)
    expect(result.message).toBe("boom")
    expect(result.status).toBeUndefined()
  })

  test("converts string", () => {
    const result = toApiError("plain string error")

    expect(result).toBeInstanceOf(ApiError)
    expect(result.message).toBe("plain string error")
    expect(result.status).toBeUndefined()
  })

  test("converts null and undefined to stringified messages", () => {
    const nullResult = toApiError(null)
    const undefinedResult = toApiError(undefined)

    expect(nullResult).toBeInstanceOf(ApiError)
    expect(nullResult.message).toBe("null")
    expect(nullResult.status).toBeUndefined()
    expect(undefinedResult).toBeInstanceOf(ApiError)
    expect(undefinedResult.message).toBe("undefined")
    expect(undefinedResult.status).toBeUndefined()
  })
})

describe("github.error rate limits", () => {
  test("retries a 429 exactly once", async () => {
    let calls = 0
    const result = await Effect.runPromise(
      withRateLimitRetry(() => {
        calls += 1
        if (calls === 1)
          return Promise.reject(
            { message: "limited", status: 429, response: { headers: { "x-ratelimit-reset": 1 } } },
          )
        return Promise.resolve("ok")
      }),
    )
    expect(result).toBe("ok")
    expect(calls).toBe(2)
  })

  test("recognizes and retries a rate-limit 403", async () => {
    expect(isRateLimited(new ApiError({ message: "API rate limit exceeded", status: 403 }))).toBe(true)
    let calls = 0
    await Effect.runPromise(
      withRateLimitRetry(() => {
        calls += 1
        if (calls === 1)
          return Promise.reject(
            { message: "Rate limit", status: 403, response: { headers: { "x-ratelimit-reset": 1 } } },
          )
        return Promise.resolve("ok")
      }),
    )
    expect(calls).toBe(2)
  })

  test.each([
    [403, "Forbidden"],
    [404, "Not Found"],
  ])("does not retry status %i without a rate-limit signal", async (status, message) => {
    let calls = 0
    const exit = await Effect.runPromise(
      withRateLimitRetry(() => {
        calls += 1
        return Promise.reject({ message, status })
      }).pipe(Effect.exit),
    )
    expect(exit._tag).toBe("Failure")
    expect(calls).toBe(1)
  })

  it.effect("sleeps for retry-after before retrying", () =>
    Effect.gen(function* () {
      let calls = 0
      const fiber = yield* withRateLimitRetry(() => {
        calls += 1
        if (calls === 1)
          return Promise.reject({ message: "limited", status: 429, response: { headers: { "retry-after": 2 } } })
        return Promise.resolve("ok")
      }).pipe(Effect.forkChild)
      while (calls === 0) yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* TestClock.adjust("1999 millis")
      expect(calls).toBe(1)
      yield* TestClock.adjust("1 millis")
      expect(yield* Fiber.join(fiber)).toBe("ok")
      expect(calls).toBe(2)
    }),
  )

  it.effect("sleeps until x-ratelimit-reset before retrying", () =>
    Effect.gen(function* () {
      let calls = 0
      const fiber = yield* withRateLimitRetry(() => {
        calls += 1
        if (calls === 1)
          return Promise.reject(
            {
              message: "limited",
              status: 429,
              response: { headers: { "x-ratelimit-reset": Date.now() / 1_000 + 2 } },
            },
          )
        return Promise.resolve("ok")
      }).pipe(Effect.forkChild)
      while (calls === 0) yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 second")
      expect(calls).toBe(1)
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(fiber)).toBe("ok")
      expect(calls).toBe(2)
    }),
  )

  it.effect("falls back to a capped 60-second sleep for missing or zero headers", () =>
    Effect.gen(function* () {
      yield* Effect.forEach([undefined, { "retry-after": 0, "x-ratelimit-reset": 0 }], (headers) =>
        Effect.gen(function* () {
          let calls = 0
          const fiber = yield* withRateLimitRetry(() => {
            calls += 1
            if (calls === 1) return Promise.reject({ message: "limited", status: 429, response: { headers } })
            return Promise.resolve("ok")
          }).pipe(Effect.forkChild)
          while (calls === 0) yield* Effect.yieldNow
          yield* Effect.yieldNow
          yield* TestClock.adjust("59999 millis")
          expect(calls).toBe(1)
          yield* TestClock.adjust("1 millis")
          expect(yield* Fiber.join(fiber)).toBe("ok")
          expect(calls).toBe(2)
        }),
      )
    }),
  )
})
