export * as ProviderWatchdog from "./provider-watchdog"

import { Context, Duration, Layer } from "effect"
import { makeLocationNode } from "../../effect/app-node"

export interface Interface {
  /** Per-pull idle deadline, applied AFTER the first chunk, that resets on every chunk. `undefined` disables idle. */
  readonly idle: Duration.Input | undefined
  /** Absolute budget for one provider turn (one llm.stream call). `undefined` disables it. */
  readonly absolute: Duration.Input | undefined
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
 * suggested 600s for absolute; this diverges to 1800s — see SLICE-012 report.) Both are
 * overridden by the harness configuration surface in a later slice.
 */
export const defaultLayer = Layer.succeed(Service, Service.of({ idle: "30 seconds", absolute: "1800 seconds" }))

export const node = makeLocationNode({ service: Service, layer: defaultLayer, deps: [] })
