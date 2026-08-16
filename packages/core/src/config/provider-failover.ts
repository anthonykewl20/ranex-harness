export * as ConfigProviderFailover from "./provider-failover"

import { Schema } from "effect"

const ModelReference = Schema.String.check(
  Schema.isPattern(/^[^/]+\/.+$/),
).annotate({ description: "Provider and model in provider/model form" })

export class Info extends Schema.Class<Info>("ConfigV2.ProviderFailover")({
  chain: Schema.Array(ModelReference).pipe(Schema.optional),
  on_watchdog: Schema.Boolean.pipe(Schema.optional),
}) {}
