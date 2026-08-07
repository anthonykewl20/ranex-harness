export * as ConfigProviderWatchdog from "./provider-watchdog"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

// Ceilings are magnitude-typo guards, not policy: a watchdog can still be fully
// disabled by omitting the field. idle_ms mirrors the harness's existing
// per-command ceiling (tool/bash MAX_TIMEOUT_MS = 600_000); absolute_ms allows a
// longer whole-provider-turn budget. Floors are positive only — the safe idle
// floor depends on the provider's time-to-first-token and is operator-tuned.
const IDLE_MAX_MS = 600_000
const ABSOLUTE_MAX_MS = 3_600_000

// If idle_ms exceeds absolute_ms the idle watchdog can never fire before the
// whole-turn budget cuts in — config that looks set and silently does nothing,
// the same failure mode this slice replaced. Refused at decode (load) time.
const idleWithinAbsolute = Schema.makeFilter((input: { idle_ms?: number; absolute_ms?: number }) =>
  input.idle_ms !== undefined && input.absolute_ms !== undefined && input.idle_ms > input.absolute_ms
    ? `idle_ms (${input.idle_ms}) must not exceed absolute_ms (${input.absolute_ms}): the idle watchdog would be unreachable`
    : undefined,
)

export class Info extends Schema.Class<Info>("ConfigV2.ProviderWatchdog")(
  Schema.Struct({
    idle_ms: PositiveInt.check(Schema.isLessThanOrEqualTo(IDLE_MAX_MS)).pipe(Schema.optional).annotate({
      description:
        "Per-chunk inactivity budget in milliseconds. Resets on every streamed chunk and fires when the provider goes quiet mid-stream. Omit to disable the idle watchdog.",
    }),
    absolute_ms: PositiveInt.check(Schema.isLessThanOrEqualTo(ABSOLUTE_MAX_MS)).pipe(Schema.optional).annotate({
      description:
        "Whole-provider-turn budget in milliseconds. Interrupts the turn when it overruns regardless of chunk activity. Omit to disable the absolute watchdog.",
    }),
  }).check(idleWithinAbsolute),
) {}
