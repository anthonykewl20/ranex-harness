import { SessionV1 } from "@ranex/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "./session"

// Plan-mode reminders (plan prompt injection, plan→build switch banners) were
// removed with the plan workflow. Kept as a pass-through so the prompt
// pipeline's call site and signature stay stable.
export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  return input.messages
})

export * as SessionReminders from "./reminders"
