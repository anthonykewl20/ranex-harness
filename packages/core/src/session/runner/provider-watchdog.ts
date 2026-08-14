export * as ProviderWatchdog from "./provider-watchdog"

import { Context, Duration, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../../effect/app-node"
import { Config } from "../../config"
import { ConfigProviderWatchdog } from "../../config/provider-watchdog"

export interface Settings {
  /** Per-pull idle deadline, applied AFTER the first chunk, that resets on every chunk. `undefined` disables idle. */
  readonly idle: Duration.Input | undefined
  /** Absolute budget for one provider turn (one llm.stream call). `undefined` disables it. */
  readonly absolute: Duration.Input | undefined
}

export interface Interface {
  readonly settings: () => Effect.Effect<Settings>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ProviderWatchdog") {}

/**
 * Production defaults. The idle deadline starts only after the first chunk arrives, so it
 * measures inter-chunk silence — not time-to-first-token (TTFT), which is the absolute
 * budget's job. Inter-chunk gaps during active streaming run ~10-100ms (issue #2 research),
 * so 30s is roughly 300-3000x headroom: it flags a socket that goes silent mid-stream
 * within half a minute without ever risking a false cut, and no reasoning model's TTFT can
 * trip it because the timer is not running during TTFT. Absolute caps one provider turn
 * (one llm.stream call, not the whole run — the runner loops, so an N-step turn gets
 * N×absolute) at thirty minutes: every legitimate single-call duration (long output,
 * extended thinking) completes well under this, so it catches only a true runaway or a
 * trickle-forever socket that keeps idle resetting, never real work. (Terminal 6's research
 * suggested 600s for absolute; this diverges to 1800s — see SLICE-012 report.) Both can be
 * overridden by the harness Config service.
 */
export const defaults = { idle: 30_000, absolute: 1_800_000 } as const

export const defaultLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    return Service.of({
      settings: Effect.fn("ProviderWatchdog.settings")(function* () {
        const values = (yield* config.entries())
          .filter((entry): entry is Config.Document => entry.type === "document")
          .flatMap((entry) => (entry.info.provider_watchdog ? [entry.info.provider_watchdog] : []))
          .reduce<{ readonly idle: number; readonly absolute: number }>(
            (result, current) => ({
              idle: current.idle_ms ?? result.idle,
              absolute: current.absolute_ms ?? result.absolute,
            }),
            defaults,
          )
        yield* Schema.decodeUnknownEffect(ConfigProviderWatchdog.Info)({
          idle_ms: values.idle,
          absolute_ms: values.absolute,
        }).pipe(Effect.orDie)
        return values
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer: defaultLayer, deps: [Config.node] })
