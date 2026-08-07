export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@ranex/schema/event"
import { EventManifest } from "@ranex/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
