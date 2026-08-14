import { EventV2 } from "@ranex/core/event"
import { OpenCodeEvent } from "@ranex/protocol/groups/event"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"

const subscriberCapacity = 256

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(Schema.encodeUnknownSync(OpenCodeEvent)(data)),
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    return handlers.handleRaw("event.subscribe", (ctx) =>
      Effect.gen(function* () {
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          data: {},
        }
        const output = Stream.scoped(
          Stream.unwrap(
            Effect.gen(function* () {
              // Acquiring the bounded stream installs its listener before readiness is observable.
              const live = yield* EventV2.allBoundedScoped(events, subscriberCapacity, (event) => {
                if (!ctx.query.directory && !ctx.query.workspaceID) return true
                if (!event.location) return true
                if (ctx.query.directory && event.location.directory !== ctx.query.directory) return false
                if (ctx.query.workspaceID && event.location.workspaceID !== ctx.query.workspaceID) return false
                return true
              })
              return Stream.make(connected).pipe(Stream.concat(live))
            }),
          ),
        ).pipe(Stream.map(eventData), Stream.pipeThroughChannel(Sse.encode()))
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
