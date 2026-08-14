export * as ProjectedEvent from "./projected-event"

import { Schema } from "effect"
import { Event } from "./event"
import { Location } from "./location"
import { ManagedOutput } from "./managed-output"
import { optional } from "./schema"

/** Public bounded envelope. Canonical event data remains in the durable event store. */
export const Envelope = Schema.Struct({
  id: Event.ID,
  type: Schema.String,
  metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
  durable: optional(Schema.Struct({ aggregateID: Schema.String, seq: Schema.Int, version: Schema.Int })),
  location: optional(Location.Ref),
  data: Schema.Unknown,
  truncated: Schema.Boolean,
  payloadID: optional(Event.ID),
  outputRefs: optional(Schema.Array(ManagedOutput.ID)),
}).annotate({ identifier: "ProjectedEvent" })
export type Envelope = typeof Envelope.Type
