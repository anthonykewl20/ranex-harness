import { makeDefaultApi } from "@ranex/protocol/api"
import { LocationMiddleware } from "./location"
import { SessionLocationMiddleware } from "./middleware/session-location"
import { TicketGroup } from "./ticket"

export const Api = makeDefaultApi({
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
}).add(TicketGroup)
