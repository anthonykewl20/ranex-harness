import type { TuiPluginApi } from "@ranex/plugin/tui"
import type { AssistantMessage, Part, ReasoningPart, ToolPart, UserMessage } from "@ranex/sdk/v2"
import type { TranscriptItem } from "./entry"

/**
 * Durable state, projected into the closed set the transcript renders.
 *
 * One read, many renders. Every count and label the transcript shows comes from
 * this projection and nowhere else — the defect filed against the design target
 * as a status line that contradicts the command reporting the same figure
 * (claude-code #74355, #53712) is two reads compared, and this is how that is
 * refused rather than remembered.
 */
export function projectItems(api: TuiPluginApi, sessionID: string): readonly TranscriptItem[] {
  const items: TranscriptItem[] = []

  for (const message of api.state.session.messages(sessionID)) {
    const parts = api.state.part(message.id)

    if (message.role === "user") {
      items.push({ kind: "user", id: message.id, message: message as UserMessage, parts })
      continue
    }

    const assistant = message as AssistantMessage
    // Reasoning and tool calls are their own entries rather than nested inside
    // the assistant's, so each collapses, streams and is copied on its own.
    // ADR-018's rule holds here: a state a renderer cannot distinguish is shown
    // as undistinguished, never folded into the nearest familiar one.
    for (const part of parts) {
      if (part.type === "reasoning") {
        items.push({ kind: "reasoning", id: part.id, part: part as ReasoningPart, message: assistant })
        continue
      }
      if (part.type === "tool") {
        items.push({ kind: "tool", id: part.id, part: part as ToolPart, message: assistant })
      }
    }

    items.push({
      kind: "assistant",
      id: message.id,
      message: assistant,
      parts: parts.filter((part: Part) => part.type === "text"),
    })
  }

  for (const request of api.state.session.permission(sessionID)) {
    items.push({
      kind: "permission",
      id: request.id,
      // Every outstanding request, not `permissions()[0]`. Upstream shows one and
      // hides the rest along with every question; CHAT-09 renders them all.
      //
      // `permission` is the field the API actually carries, and it names what is
      // being asked for. It is shown verbatim: a permission prompt that
      // paraphrases what it is requesting is how #83879's wrong selections
      // happen, and the operator must approve the thing, not a summary of it.
      request: { id: request.id, title: request.permission, body: request.patterns.join(", ") },
    })
  }

  return items
}
