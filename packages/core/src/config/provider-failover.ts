export * as ConfigProviderFailover from "./provider-failover"

import { Schema } from "effect"

export const MAX_CHAIN_LENGTH = 8

const ModelReference = Schema.String.check(
  Schema.isPattern(/^[^/]+\/.+$/),
).annotate({ description: "Provider and model in provider/model form" })

// Each fallback gets a fresh provider-retry elapsed window. Worst-case provider
// calls are (1 + chain length) × max_attempts, so keep the chain bounded.
const Chain = Schema.Array(ModelReference).check(
  Schema.makeFilter((chain) =>
    chain.length > MAX_CHAIN_LENGTH
      ? `provider_failover.chain must contain at most ${MAX_CHAIN_LENGTH} models`
      : undefined,
  ),
)

export class Info extends Schema.Class<Info>("ConfigV2.ProviderFailover")({
  chain: Chain.pipe(Schema.optional),
  on_watchdog: Schema.Boolean.pipe(Schema.optional),
}) {}
