import type { TranscriptItem } from "./entry"

/**
 * CHAT-15 — copy that needs no repair.
 *
 * The operation operators perform most, and the one the field gets wrong.
 * claude-code #5512 asks for a `/copy` command; #83236 reports that copying an
 * assistant message "requires a two-step pointer interaction with no bindable
 * keyboard action", filed as a screen-reader defect; #75221 asks for an option
 * to strip the left gutter because it is copied along with the text.
 *
 * The gutter problem does not arise here — bodies are already flush left, proven
 * in `transcript-presentation.test.tsx` against a painted frame. What remains is
 * making copy reachable from the keyboard and making it copy the *content*
 * rather than the chrome.
 */

/** The text of an item, as the operator would want it pasted elsewhere. */
export function copyText(item: TranscriptItem): string | undefined {
  switch (item.kind) {
    case "user":
    case "assistant":
      // The body only. A label line is chrome — pasting "ranex  deepseek · zen"
      // into a bug report is noise, and the reader wanted the answer.
      return (
        item.parts
          .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
          .join("")
          .trim() || undefined
      )
    case "reasoning": {
      const part = item.part as unknown as { text?: unknown }
      return typeof part.text === "string" && part.text.trim().length > 0 ? part.text.trim() : undefined
    }
    case "tool": {
      const state = (item.part as unknown as { state?: { output?: unknown; metadata?: Record<string, unknown> } }).state
      // A change is more useful as its diff than as its prose summary, and it is
      // what a bug report needs.
      const diff = state?.metadata?.diff
      if (typeof diff === "string" && diff.length > 0) return diff
      return typeof state?.output === "string" && state.output.length > 0 ? state.output : undefined
    }
    case "permission":
      return `${item.request.title}${item.request.body ? `\n${item.request.body}` : ""}`
    case "error":
      return item.why
  }
}

/**
 * The item a bare copy takes: the most recent one that has text.
 *
 * Not simply the last item — the last is often a tool call still running, and
 * copying an empty string while reporting success is the failure mode of
 * claude-code #56298, where "Copy message" silently copied nothing.
 */
export function lastCopyable(items: readonly TranscriptItem[]): TranscriptItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item && copyText(item)) return item
  }
  return undefined
}
