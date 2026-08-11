import { createSignal } from "solid-js"
import { detectGlyphs } from "../../../theme/glyphs"
import { EntryFrame } from "../chrome"
import type { TranscriptEntry } from "../entry"

const glyphs = detectGlyphs()

/**
 * CHAT-06 — the tool entry, and the largest complaint class in the field.
 *
 * claude-code #57060: tool output expanded by default with a collapse toggle
 * that does nothing. #56423: no setting, inconsistent across machines. Upstream
 * from the other side: opencode #14511, #14640, #15488 all ask for a way to
 * collapse or hide it.
 *
 * So: **collapsed by default, and the collapsed line carries the outcome.** A
 * collapsed line showing only the tool name is #57060's defect with a working
 * toggle — the reader still has to expand to learn what happened.
 */

/** Middle truncation: a path's identifying part is its end, so never cut the tail. */
export function truncateMiddle(value: string, max = 48): string {
  if (value.length <= max) return value
  const head = Math.ceil((max - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - (max - 1 - head))}`
}

/** The subject: what the call was *about*, spelled, never an emoji. */
export function toolSubject(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  for (const key of ["filePath", "path", "pattern", "command", "url", "description"]) {
    const value = input[key]
    if (typeof value === "string" && value.length > 0) return truncateMiddle(value)
  }
  return ""
}

/**
 * The outcome column. Never blank, and never carried by colour alone: a failure
 * says so in words, which is what keeps it legible under NO_COLOR and to a
 * screen reader (ux-research.md §10).
 */
export function toolOutcome(state: { status?: string; error?: unknown } | undefined): string {
  const status = state?.status
  if (status === "completed") return "done"
  if (status === "error") return "failed"
  if (status === "running") return "running"
  if (status === "pending") return "queued"
  return status ?? "unknown"
}

export const ToolEntry: TranscriptEntry<"tool"> = {
  id: "ranex.transcript.tool",
  kind: "tool",
  order: 400,
  render: (props) => {
    const [open, setOpen] = createSignal(false)
    const theme = () => props.api.theme.current
    const part = () => props.item.part as unknown as { tool?: string; state?: Record<string, unknown> }
    const state = () => part().state as { status?: string; input?: Record<string, unknown>; output?: unknown }

    return (
      <box onMouseDown={() => setOpen((x) => !x)}>
        <EntryFrame
          api={props.api}
          glyph={open() ? glyphs.down : glyphs.right}
          label={part().tool ?? "tool"}
          detail={toolSubject(state()?.input)}
          outcome={toolOutcome(state())}
        >
          {open() ? (
            <text fg={theme().textMuted} wrapMode="word">
              {typeof state()?.output === "string" ? (state().output as string) : ""}
            </text>
          ) : null}
        </EntryFrame>
      </box>
    )
  },
}
