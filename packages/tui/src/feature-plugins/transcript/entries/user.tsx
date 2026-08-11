import { EntryFrame } from "../frame"
import type { TranscriptEntry } from "../entry"

/**
 * CHAT-03 — the user entry.
 *
 * Small, and it sets the rule the whole surface follows: identity is a label
 * line above the content, never a rule beside it. The body is flush left so it
 * copies without repair (claude-code #75221, #74239).
 */
export const UserEntry: TranscriptEntry<"user"> = {
  id: "ranex.transcript.user",
  kind: "user",
  order: 100,
  render: (props) => {
    const theme = () => props.api.theme.current
    const text = props.item.parts
      .filter((part) => part.type === "text")
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim()

    return (
      <EntryFrame api={props.api} label="you" tone={props.api.theme.current.accent} tinted>
        {/* An empty message renders an explicit marker rather than a blank gap,
            which would read as a rendering fault rather than as an empty turn. */}
        <text fg={theme().text} wrapMode="word">
          {text.length > 0 ? text : "(empty message)"}
        </text>
      </EntryFrame>
    )
  },
}
