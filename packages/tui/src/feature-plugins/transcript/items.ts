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
/**
 * A cheap fingerprint of everything an entry renders.
 *
 * Two items with the same signature paint the same pixels, so the previous
 * object can be handed back and Solid's `For` — which keys on object identity —
 * leaves that row's nodes alone.
 */
function signature(item: TranscriptItem): string {
  switch (item.kind) {
    case "user":
    case "assistant": {
      const text = item.parts.map((p) => ("text" in p && typeof p.text === "string" ? p.text.length : 0)).join(",")
      return `${item.kind}:${text}:${item.kind === "assistant" ? (item.modelChange ?? "") : ""}:${
        item.kind === "assistant" ? (item.message.time?.completed ?? "") : ""
      }`
    }
    case "reasoning": {
      const part = item.part as unknown as { text?: unknown }
      return `reasoning:${typeof part.text === "string" ? part.text.length : 0}`
    }
    case "tool": {
      const state = (item.part as unknown as { state?: { status?: string; output?: unknown } }).state
      const output = typeof state?.output === "string" ? state.output.length : 0
      return `tool:${state?.status ?? ""}:${output}`
    }
    case "permission":
      return `permission:${item.request.title}`
    case "error":
      return `error:${item.why}`
  }
}

/**
 * Items that keep their identity across renders when nothing about them changed.
 *
 * Without this the projection returned freshly-allocated objects every time any
 * state moved, so `For` saw an entirely new list on every streamed delta and
 * rebuilt every row — the whole transcript repainting per token, which reads as
 * flicker and is exactly what it looks like. Only the row whose signature
 * actually changed is rebuilt now.
 */
export function createProjection() {
  const cache = new Map<string, TranscriptItem>()
  return (api: TuiPluginApi, sessionID: string): readonly TranscriptItem[] => {
    const fresh = projectItems(api, sessionID)
    const seen = new Set<string>()
    const stable = fresh.map((item) => {
      seen.add(item.id)
      const previous = cache.get(item.id)
      if (previous && signature(previous) === signature(item)) return previous
      cache.set(item.id, item)
      return item
    })
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id)
    return stable
  }
}

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
    // One thought per turn, not one per reasoning part.
    //
    // A turn emits several reasoning parts and rendering each as its own entry
    // put `thought` four or five times down a single turn, at the same weight as
    // the tool calls between them. Upstream shows one collapsed block per turn,
    // and it is right: the reasoning is one thing the model did, not four.
    const reasoning = parts.filter((part) => part.type === "reasoning")
    if (reasoning[0]) {
      items.push({ kind: "reasoning", id: reasoning[0].id, part: reasoning[0] as ReasoningPart, message: assistant })
    }
    for (const part of parts) {
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
