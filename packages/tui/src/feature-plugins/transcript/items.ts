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
  // The model of the previous assistant turn, so a change can be spotted. The
  // provider id is deliberately not part of this: it is an internal identifier
  // (`opencode`) and naming another product on every reply is not information.
  let previousModel: string | undefined

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

    // Only when the turn actually said something.
    //
    // A turn that was purely tool calls has no text parts, and emitting an entry
    // for it printed a bare `ranex` header with nothing under it — once per
    // tool-calling turn, so a long task produced a column of empty labels. The
    // tool entries above already carry that turn's visible work.
    const text = parts.filter((part: Part) => part.type === "text")
    const spoke = text.some((part) => "text" in part && typeof part.text === "string" && part.text.trim().length > 0)
    const model = assistant.modelID
    if (spoke) {
      items.push({
        kind: "assistant",
        id: message.id,
        message: assistant,
        parts: text,
        modelChange: previousModel && model && model !== previousModel ? model : undefined,
      })
    }
    if (model) previousModel = model
  }

  // Permissions are deliberately **not** projected here yet.
  //
  // They belong in `session_blocker`, not in the body, and that slot is still
  // unfilled — so upstream's `PermissionPrompt` renders and works. Projecting
  // them here as well would show every request twice: once docked in the stream
  // and once fullscreen over it.
  //
  // Filling the slot has to wait on the question flow, because `replace` takes
  // the whole region and `QuestionPrompt` lives in it. An approval surface that
  // renders but cannot reply is worse than the fullscreen one it replaces, so
  // `PermissionEntry` stays built, tested and unwired until CHAT-09 carries the
  // reply path with it.

  return items
}
