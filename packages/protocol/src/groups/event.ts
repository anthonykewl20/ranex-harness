import type { Definition } from "@ranex/schema/event"
import { AbsolutePath } from "@ranex/schema/schema"
import { ProjectedEvent } from "@ranex/schema/projected-event"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

export const EventSubscriptionQuery = Schema.Struct({
  directory: Schema.optional(AbsolutePath.check(Schema.isStartsWith("/"))),
  workspaceID: Schema.optional(Schema.String),
  clientID: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))),
}).annotate({ identifier: "EventSubscriptionQuery" })

const make = () => {
  const EventSchema = ProjectedEvent.Envelope
  return {
    schema: EventSchema,
    group: HttpApiGroup.make("server.event")
      .add(
        HttpApiEndpoint.get("event.subscribe", "/api/event", {
          query: EventSubscriptionQuery,
          success: HttpApiSchema.StreamSse({ data: EventSchema }),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "v2.event.subscribe",
            summary: "Subscribe to events",
            description: "Subscribe to native event payloads for the server.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "events", description: "Experimental event stream route." })),
  }
}

export const makeEventGroup = <const Definitions extends ReadonlyArray<Definition>>(_: Definitions) => make().group

const event = make()
export const EventGroup = event.group
export const OpenCodeEvent = event.schema
export type OpenCodeEvent = typeof OpenCodeEvent.Type
export type OpenCodeEventEncoded = typeof OpenCodeEvent.Encoded
