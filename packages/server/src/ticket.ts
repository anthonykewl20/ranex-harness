import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@ranex/protocol/middleware/authorization"

export class TicketUnavailableError extends Schema.TaggedErrorClass<TicketUnavailableError>()(
  "TicketUnavailableError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

// Mirrors ServerAuth.TicketScope. A query field (not a body field) so
// existing bodyless mint clients keep working untouched.
const TicketScope = Schema.Literals(["url-auth", "api"])

// Carries the Authorization middleware on the group itself: api-level
// middleware added inside the protocol api factory does not reach groups
// appended afterwards, and an unauthenticated mint endpoint would defeat
// the tickets entirely.
export const TicketGroup = HttpApiGroup.make("server.ticket")
  .add(
    HttpApiEndpoint.post("ticket.mint", "/api/ticket", {
      query: Schema.Struct({
        scope: Schema.optional(TicketScope).annotate({
          description:
            'Ticket scope: "url-auth" (default) limits the ticket to the URL-auth endpoints (SSE event stream, PTY WebSocket connect, web UI navigation); "api" accepts the query channel on any endpoint.',
        }),
      }),
      success: Schema.Struct({
        ticket: Schema.String,
        expiresAt: Schema.String,
      }),
      error: TicketUnavailableError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.ticket.mint",
        summary: "Mint URL auth ticket",
        description:
          "Mint a short-lived stateless ticket accepted by the auth_token query parameter. Requires Basic credentials in the Authorization header. The ticket is scoped: by default it only authorizes URL auth on the endpoints whose channel cannot carry headers (SSE event stream, PTY WebSocket connect, web UI); pass scope=api for a full-API ticket.",
      }),
    ),
  )
  .middleware(Authorization)
