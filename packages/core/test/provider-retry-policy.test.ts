import { describe, expect } from "bun:test"
import {
  AuthenticationReason,
  ContentPolicyReason,
  InvalidRequestReason,
  InvalidProviderOutputReason,
  LLMError,
  ModelID,
  NoRouteReason,
  ProviderInternalReason,
  ProviderID,
  QuotaExceededReason,
  RateLimitReason,
  RouteID,
  TransportReason,
  UnknownProviderReason,
} from "@ranex/llm"
import { Config } from "@ranex/core/config"
import { ConfigProviderRetry } from "@ranex/core/config/provider-retry"
import { ProviderRetryPolicy } from "@ranex/core/session/runner/provider-retry"
import { Effect, Layer, Option, Random, Schema } from "effect"
import { testEffect } from "./lib/effect"

class RetryableTransportReason extends TransportReason {
  override get retryable() {
    return true
  }
}

const config = (provider_retry?: ConfigProviderRetry.Info) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed(
          provider_retry ? [new Config.Document({ type: "document", info: new Config.Info({ provider_retry }) })] : [],
        ),
    }),
  )

const policy = (provider_retry?: ConfigProviderRetry.Info) =>
  ProviderRetryPolicy.defaultLayer.pipe(Layer.provide(config(provider_retry)))

const error = (reason: ConstructorParameters<typeof LLMError>[0]["reason"]) =>
  new LLMError({ module: "test", method: "provider", reason })

const decision = (reason: ConstructorParameters<typeof LLMError>[0]["reason"], overrides = {}) =>
  Effect.gen(function* () {
    const service = yield* ProviderRetryPolicy.Service
    return yield* service.decide({
      error: error(reason),
      completed_attempt: 1,
      assistant_started: false,
      interrupted: false,
      cumulative_delay_ms: 0,
      window_started_at: 0,
      ...overrides,
    })
  })

describe("provider retry config", () => {
  const decode = Schema.decodeUnknownOption(Config.Info, { errors: "all", onExcessProperty: "ignore" })

  testEffect(Layer.empty).effect("rejects invalid bounds before the runner starts", () =>
    Effect.sync(() => {
      const invalid = [
        { max_attempts: 0 },
        { base_delay_ms: -1 },
        { base_delay_ms: 2_000, max_delay_ms: 1_000 },
        { jitter_ratio: -0.01 },
        { jitter_ratio: 1.01 },
        { max_attempts: 6 },
        { max_cumulative_delay_ms: 30_001 },
        { max_elapsed_ms: 120_001 },
      ]
      invalid.forEach((provider_retry) => expect(Option.isNone(decode({ provider_retry }))).toBe(true))
    }),
  )
})

describe("provider retry policy", () => {
  testEffect(policy()).effect("classifies only retry-safe failures", () =>
    Effect.gen(function* () {
      expect(yield* decision(new RateLimitReason({ message: "limited" }))).toMatchObject({
        _tag: "Retry",
        class: "rate_limit",
        delay_ms: 500,
      })
      expect(yield* decision(new RetryableTransportReason({ message: "socket reset" }))).toMatchObject({
        _tag: "Retry",
        class: "transport",
      })
      expect(yield* decision(new TransportReason({ message: "socket reset" }))).toEqual({
        _tag: "Stop",
        reason: "non-retryable",
      })
      expect(yield* decision(new ProviderInternalReason({ message: "unavailable", status: 503 }))).toMatchObject({
        _tag: "Retry",
        class: "server",
      })
      expect(yield* decision(new ProviderInternalReason({ message: "bad request", status: 400 }))).toEqual({
        _tag: "Stop",
        reason: "non-retryable",
      })
      expect(yield* decision(new TransportReason({ message: "watchdog", kind: "watchdog-absolute" }))).toMatchObject({
        _tag: "Retry",
        class: "timeout",
      })
      expect(
        yield* decision(new InvalidRequestReason({ message: "overflow", classification: "context-overflow" })),
      ).toEqual({ _tag: "Stop", reason: "non-retryable" })
      expect(yield* decision(new AuthenticationReason({ message: "denied", kind: "invalid" }))).toEqual({
        _tag: "Stop",
        reason: "non-retryable",
      })
      expect(yield* decision(new QuotaExceededReason({ message: "quota exhausted" }))).toEqual({
        _tag: "Stop",
        reason: "non-retryable",
      })
      expect(yield* decision(new ContentPolicyReason({ message: "policy denied" }))).toEqual({
        _tag: "Stop",
        reason: "non-retryable",
      })
      expect(yield* decision(new InvalidProviderOutputReason({ message: "unsupported prefill" }))).toEqual({
        _tag: "Stop",
        reason: "non-retryable",
      })
      expect(yield* decision(new UnknownProviderReason({ message: "unknown" }))).toEqual({
        _tag: "Stop",
        reason: "non-retryable",
      })
      expect(
        yield* decision(
          new NoRouteReason({
            route: RouteID.make("test"),
            provider: ProviderID.make("test"),
            model: ModelID.make("test"),
          }),
        ),
      ).toEqual({ _tag: "Stop", reason: "non-retryable" })
    }),
  )

  testEffect(policy()).effect("honors exponential delay, retry-after, and hard budgets", () =>
    Effect.gen(function* () {
      const rateLimit = new RateLimitReason({ message: "limited", retryAfterMs: 750 })
      expect(yield* decision(rateLimit)).toMatchObject({ _tag: "Retry", delay_ms: 750 })
      expect(
        yield* decision(rateLimit, {
          retry_after_ms: 20_000,
          cumulative_delay_ms: 19_999,
        }),
      ).toMatchObject({ _tag: "Retry", delay_ms: 10_000 })
      expect(
        yield* decision(rateLimit, {
          retry_after_ms: 20_000,
          cumulative_delay_ms: 20_001,
        }),
      ).toEqual({ _tag: "Stop", reason: "cumulative-delay-ceiling" })
      expect(
        yield* decision(rateLimit, {
          retry_after_ms: 20_000,
          window_started_at: -110_001,
        }),
      ).toEqual({ _tag: "Stop", reason: "elapsed-ceiling" })
      expect(yield* decision(rateLimit, { completed_attempt: 2, cumulative_delay_ms: 29_100 })).toEqual({
        _tag: "Stop",
        reason: "cumulative-delay-ceiling",
      })
      expect(yield* decision(rateLimit, { completed_attempt: 3 })).toEqual({ _tag: "Stop", reason: "attempt-ceiling" })
      expect(yield* decision(rateLimit, { window_started_at: -120_000 })).toEqual({
        _tag: "Stop",
        reason: "elapsed-ceiling",
      })
      expect(yield* decision(rateLimit, { assistant_started: true })).toEqual({
        _tag: "Stop",
        reason: "assistant-started",
      })
      expect(yield* decision(rateLimit, { interrupted: true })).toEqual({ _tag: "Stop", reason: "interrupted" })
    }),
  )

  testEffect(policy(new ConfigProviderRetry.Info({ jitter_ratio: 1, base_delay_ms: 100, max_delay_ms: 100 }))).effect(
    "uses seeded Random to keep jitter deterministic and inside the bounded delay range",
    () =>
      Effect.gen(function* () {
        // Random.withSeed, not TestClock, makes the jitter repeatable.
        const result = yield* decision(new RateLimitReason({ message: "limited" })).pipe(Random.withSeed(1))
        const repeated = yield* decision(new RateLimitReason({ message: "limited" })).pipe(Random.withSeed(1))
        expect(result._tag).toBe("Retry")
        expect(result).toEqual(repeated)
        if (result._tag === "Retry") expect(result.delay_ms).toBeGreaterThanOrEqual(0)
        if (result._tag === "Retry") expect(result.delay_ms).toBeLessThanOrEqual(100)
      }),
  )
})
