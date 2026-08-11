import { detectGlyphs } from "../../../theme/glyphs"
import { EntryFrame } from "../frame"
import { Markdown } from "../render/markdown"
import type { TranscriptEntry } from "../entry"

const glyphs = detectGlyphs()

/**
 * CHAT-04 — the assistant entry.
 *
 * **The model is not on every message.** Repeating it every turn is noise — the
 * same value fifty times down the screen — and it put the *provider id*, the
 * literal string `opencode`, onto every reply in a product that is not opencode.
 *
 * It appears only when it **changes**, which is the case that matters.
 * `ux-research.md` §3 adopted kilocode's "silent fallback to default model"
 * complaint: a turn that ran under a different model than the one before it must
 * be visible. Always-on and on-change carry the same information; only the
 * second is legible, and only the second makes a change stand out.
 */
export const AssistantEntry: TranscriptEntry<"assistant"> = {
  id: "ranex.transcript.assistant",
  kind: "assistant",
  order: 200,
  render: (props) => {
    const text = props.item.parts
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim()

    return (
      <EntryFrame api={props.api} glyph={glyphs.dot} label="ranex" detail={props.item.modelChange}>
        <Markdown content={text} />
      </EntryFrame>
    )
  },
}
