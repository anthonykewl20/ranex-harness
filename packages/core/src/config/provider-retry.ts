export * as ConfigProviderRetry from "./provider-retry"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

// Provider turns are at-most-once: these ceilings bound recovery before a retry
// can turn a transient outage into an unbounded durable drain.
export const MAX_ATTEMPTS_CEILING = 5
export const MAX_CUMULATIVE_DELAY_MS_CEILING = 30_000
export const MAX_ELAPSED_MS_CEILING = 120_000
export const MAX_DELAY_MS_CEILING = 30_000

const delaysAreOrdered = Schema.makeFilter((input: { base_delay_ms?: number; max_delay_ms?: number }) =>
  input.base_delay_ms !== undefined && input.max_delay_ms !== undefined && input.base_delay_ms > input.max_delay_ms
    ? `base_delay_ms (${input.base_delay_ms}) must not exceed max_delay_ms (${input.max_delay_ms})`
    : undefined,
)

export class Enabled extends Schema.Class<Enabled>("ConfigV2.ProviderRetryEnabled")({
  rate_limit: Schema.Boolean.pipe(Schema.optional),
  transport: Schema.Boolean.pipe(Schema.optional),
  server: Schema.Boolean.pipe(Schema.optional),
  timeout: Schema.Boolean.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.ProviderRetry")(
  Schema.Struct({
    max_attempts: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ATTEMPTS_CEILING)).pipe(Schema.optional),
    base_delay_ms: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_DELAY_MS_CEILING)).pipe(Schema.optional),
    max_delay_ms: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_DELAY_MS_CEILING)).pipe(Schema.optional),
    max_cumulative_delay_ms: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_CUMULATIVE_DELAY_MS_CEILING)).pipe(
      Schema.optional,
    ),
    max_elapsed_ms: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ELAPSED_MS_CEILING)).pipe(Schema.optional),
    jitter_ratio: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(Schema.optional),
    enabled: Enabled.pipe(Schema.optional),
  }).check(delaysAreOrdered),
) {}
