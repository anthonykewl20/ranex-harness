export * as ProviderRetryPolicy from "./provider-retry"

import { Clock, Context, Effect, Layer, Random, Schema } from "effect"
import { LLMError } from "@ranex/llm"
import { makeLocationNode } from "../../effect/app-node"
import { Config } from "../../config"
import { ConfigProviderRetry } from "../../config/provider-retry"

export type RetryClass = "rate_limit" | "transport" | "server" | "timeout"
export type StopReason =
  | "assistant-started"
  | "interrupted"
  | "non-retryable"
  | "class-disabled"
  | "attempt-ceiling"
  | "cumulative-delay-ceiling"
  | "elapsed-ceiling"

export type Decision =
  | {
      readonly _tag: "Retry"
      readonly delay_ms: number
      readonly class: RetryClass
      readonly remaining_delay_ms: number
    }
  | { readonly _tag: "Stop"; readonly reason: StopReason }

export interface Settings {
  readonly max_attempts: number
  readonly base_delay_ms: number
  readonly max_delay_ms: number
  readonly max_cumulative_delay_ms: number
  readonly max_elapsed_ms: number
  readonly jitter_ratio: number
  readonly enabled: Readonly<Record<RetryClass, boolean>>
}

export interface Interface {
  readonly settings: () => Effect.Effect<Settings>
  readonly decide: (input: {
    readonly error: LLMError
    readonly completed_attempt: number
    readonly assistant_started: boolean
    readonly interrupted: boolean
    readonly cumulative_delay_ms: number
    readonly window_started_at: number
    readonly retry_after_ms?: number
  }) => Effect.Effect<Decision>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ProviderRetryPolicy") {}

export const defaults: Settings = {
  max_attempts: 3,
  base_delay_ms: 500,
  max_delay_ms: 10_000,
  max_cumulative_delay_ms: 30_000,
  max_elapsed_ms: 120_000,
  jitter_ratio: 0,
  enabled: { rate_limit: true, transport: true, server: true, timeout: true },
}

export const classify = (error: LLMError): RetryClass | undefined => {
  if (error.reason._tag === "RateLimit") return "rate_limit"
  if (error.reason._tag === "ProviderInternal" && error.reason.status >= 500) return "server"
  if (error.reason._tag !== "Transport") return undefined
  if (error.reason.kind === "watchdog-idle" || error.reason.kind === "watchdog-absolute") return "timeout"
  return error.retryable ? "transport" : undefined
}

export const defaultLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const settings = Effect.fn("ProviderRetryPolicy.settings")(function* () {
      const values = (yield* config.entries())
        .filter((entry): entry is Config.Document => entry.type === "document")
        .flatMap((entry) => (entry.info.provider_retry ? [entry.info.provider_retry] : []))
        .reduce<Settings>(
          (result, current) => ({
            max_attempts: current.max_attempts ?? result.max_attempts,
            base_delay_ms: current.base_delay_ms ?? result.base_delay_ms,
            max_delay_ms: current.max_delay_ms ?? result.max_delay_ms,
            max_cumulative_delay_ms: current.max_cumulative_delay_ms ?? result.max_cumulative_delay_ms,
            max_elapsed_ms: current.max_elapsed_ms ?? result.max_elapsed_ms,
            jitter_ratio: current.jitter_ratio ?? result.jitter_ratio,
            enabled: {
              rate_limit: current.enabled?.rate_limit ?? result.enabled.rate_limit,
              transport: current.enabled?.transport ?? result.enabled.transport,
              server: current.enabled?.server ?? result.enabled.server,
              timeout: current.enabled?.timeout ?? result.enabled.timeout,
            },
          }),
          defaults,
        )
      yield* Schema.decodeUnknownEffect(ConfigProviderRetry.Info)({
        max_attempts: values.max_attempts,
        base_delay_ms: values.base_delay_ms,
        max_delay_ms: values.max_delay_ms,
        max_cumulative_delay_ms: values.max_cumulative_delay_ms,
        max_elapsed_ms: values.max_elapsed_ms,
        jitter_ratio: values.jitter_ratio,
        enabled: values.enabled,
      }).pipe(Effect.orDie)
      return values
    })
    return Service.of({
      settings,
      decide: Effect.fn("ProviderRetryPolicy.decide")(function* (input) {
        if (input.assistant_started) return { _tag: "Stop", reason: "assistant-started" }
        if (input.interrupted) return { _tag: "Stop", reason: "interrupted" }
        const retryClass = classify(input.error)
        if (!retryClass) return { _tag: "Stop", reason: "non-retryable" }
        const values = yield* settings()
        if (!values.enabled[retryClass]) return { _tag: "Stop", reason: "class-disabled" }
        if (input.completed_attempt >= values.max_attempts) return { _tag: "Stop", reason: "attempt-ceiling" }
        const now = yield* Clock.currentTimeMillis
        const elapsed = now - input.window_started_at
        if (elapsed >= values.max_elapsed_ms) return { _tag: "Stop", reason: "elapsed-ceiling" }
        const base = Math.min(values.base_delay_ms * 2 ** (input.completed_attempt - 1), values.max_delay_ms)
        const jittered = Math.min(
          Math.round(base * (1 + (yield* Random.next) * 2 * values.jitter_ratio - values.jitter_ratio)),
          values.max_delay_ms,
        )
        const delay = Math.max(jittered, input.retry_after_ms ?? input.error.retryAfterMs ?? 0)
        if (input.cumulative_delay_ms + delay > values.max_cumulative_delay_ms)
          return { _tag: "Stop", reason: "cumulative-delay-ceiling" }
        if (elapsed + delay > values.max_elapsed_ms) return { _tag: "Stop", reason: "elapsed-ceiling" }
        return {
          _tag: "Retry",
          delay_ms: delay,
          class: retryClass,
          remaining_delay_ms: values.max_cumulative_delay_ms - input.cumulative_delay_ms - delay,
        }
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer: defaultLayer, deps: [Config.node] })
