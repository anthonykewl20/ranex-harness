import { detectGlyphs } from "../../../theme/glyphs"
import { EntryFrame } from "../frame"
import type { TranscriptEntry } from "../entry"

const glyphs = detectGlyphs()

/**
 * CHAT-09 — the permission entry.
 *
 * **It docks. It never overlays.** claude-code #67509 is a dialog that covers
 * the assistant message it is asking about, "with no way to read the text
 * underneath", and `routes/session/permission.tsx:401` renders `fullscreen`
 * today — the same defect in this codebase. As an entry in the transcript, in
 * position, the thing being approved stays on screen while it is approved.
 *
 * It renders **every** outstanding request. `routes/session/index.tsx:1283`
 * shows only `permissions()[0]` and hides all questions while any permission is
 * open, so a second request is invisible until the first is answered.
 *
 * Authority is not here and must never be. ADR-022 moves rendering only; the
 * reply path stays with the route, and `TranscriptBlocker` carries no handle
 * that could reach it. An entry cannot approve anything, by construction.
 */
export const PermissionEntry: TranscriptEntry<"permission"> = {
  id: "ranex.transcript.permission",
  kind: "permission",
  order: 500,
  render: (props) => {
    const theme = () => props.api.theme.current

    return (
      <EntryFrame
        api={props.api}
        glyph={glyphs.warn}
        label="approval required"
        detail={props.item.request.title}
        outcome="waiting"
      >
        {/* The subject is shown verbatim, never paraphrased. An operator
            approves the thing, not a summary of it — claude-code #83879 is
            wrong selections from an ambiguous prompt. */}
        {props.item.request.body ? (
          <text fg={theme().textMuted} wrapMode="word">
            {props.item.request.body}
          </text>
        ) : null}
      </EntryFrame>
    )
  },
}

/**
 * CHAT-09 — the error entry.
 *
 * A failure is a state with a cause, spelled. Not a spinner that never resolves
 * (claude-code #65841), and not a colour (ux-research.md §10).
 */
export const ErrorEntry: TranscriptEntry<"error"> = {
  id: "ranex.transcript.error",
  kind: "error",
  order: 600,
  render: (props) => (
    <EntryFrame api={props.api} glyph={glyphs.no} label="error" outcome="stopped">
      <text fg={props.api.theme.current.error} wrapMode="word">
        {props.item.why}
      </text>
    </EntryFrame>
  ),
}
