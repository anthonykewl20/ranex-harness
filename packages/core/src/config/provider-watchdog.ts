export * as ConfigProviderWatchdog from "./provider-watchdog"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

const IDLE_MAX_MS = 600_000
const FIRST_MAX_MS = 600_000
const ABSOLUTE_MAX_MS = 3_600_000

const watchdogsWithinAbsolute = Schema.makeFilter(
  (input: { idle_ms?: number; first_ms?: number; absolute_ms?: number }) => {
    if (input.idle_ms !== undefined && input.absolute_ms !== undefined && input.idle_ms > input.absolute_ms)
      return `idle_ms (${input.idle_ms}) must not exceed absolute_ms (${input.absolute_ms}): the idle watchdog would be unreachable`
    if (input.first_ms !== undefined && input.absolute_ms !== undefined && input.first_ms > input.absolute_ms)
      return `first_ms (${input.first_ms}) must not exceed absolute_ms (${input.absolute_ms}): the first-chunk watchdog would be unreachable`
  },
)

export class Info extends Schema.Class<Info>("ConfigV2.ProviderWatchdog")(
  Schema.Struct({
    idle_ms: PositiveInt.check(Schema.isLessThanOrEqualTo(IDLE_MAX_MS)).pipe(Schema.optional).annotate({
      description:
        "Per-chunk inactivity budget in milliseconds. Resets on every streamed chunk and fires when the provider goes quiet mid-stream. Omit to use the default.",
    }),
    first_ms: PositiveInt.check(Schema.isLessThanOrEqualTo(FIRST_MAX_MS)).pipe(Schema.optional).annotate({
      description:
        "Time-to-first-chunk budget in milliseconds. Starts when the provider stream call begins and is cancelled when its first chunk arrives. Omit to use the default.",
    }),
    absolute_ms: PositiveInt.check(Schema.isLessThanOrEqualTo(ABSOLUTE_MAX_MS)).pipe(Schema.optional).annotate({
      description:
        "Whole-provider-turn budget in milliseconds. Interrupts the turn when it overruns regardless of chunk activity. Omit to use the default.",
    }),
  }).check(watchdogsWithinAbsolute),
) {}
