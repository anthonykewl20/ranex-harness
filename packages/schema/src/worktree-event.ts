export * as WorktreeEvent from "./worktree-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"

export const Ready = Event.define({
  type: "worktree.ready",
  durable: { version: 1, aggregate: "name" },
  schema: {
    name: Schema.String,
    branch: optional(Schema.String),
  },
})

export const Failed = Event.define({
  type: "worktree.failed",
  durable: { version: 1, aggregate: "name" },
  schema: {
    name: Schema.String,
    message: Schema.String,
  },
})

export const Definitions = Event.inventory(Ready, Failed)
