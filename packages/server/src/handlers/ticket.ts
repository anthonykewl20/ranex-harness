import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ServerAuth } from "../auth"
import { Api } from "../api"
import { TicketUnavailableError } from "../ticket"

export const TicketHandler = HttpApiBuilder.group(Api, "server.ticket", (handlers) =>
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    return handlers.handle("ticket.mint", (ctx) =>
      Effect.gen(function* () {
        if (!Option.isSome(config.password) || !ServerAuth.required(config)) {
          return yield* new TicketUnavailableError({ message: "Server authentication is not configured" })
        }
        return ServerAuth.mintTicket(config.password.value, undefined, ctx.query.scope ?? "url-auth")
      }),
    )
  }),
)
