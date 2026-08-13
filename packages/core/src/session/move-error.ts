import { Schema } from "effect"
import { SessionSchema } from "./schema"

export class MoveBlockedError extends Schema.TaggedErrorClass<MoveBlockedError>()("Session.MoveBlockedError", {
  sessionID: SessionSchema.ID,
}) {}
