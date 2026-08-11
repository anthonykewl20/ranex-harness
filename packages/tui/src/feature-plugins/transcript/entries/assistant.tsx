import { detectGlyphs } from "../../../theme/glyphs"
import { EntryFrame } from "../chrome"
import type { TranscriptEntry } from "../entry"

const glyphs = detectGlyphs()

/**
 * CHAT-04 — the assistant entry.
 *
 * The label line carries agent and model, and the outcome column carries
 * duration. Markdown rendering proper is CHAT-04's second half; until it lands
 * the text renders as text, which is honest — opencode #38828 is markdown shown
 * as raw text *while claiming otherwise*, and this claims nothing.
 */
export const AssistantEntry: TranscriptEntry<"assistant"> = {
  id: "ranex.transcript.assistant",
  kind: "assistant",
  order: 200,
  render: (props) => {
    const theme = () => props.api.theme.current
    const message = props.item.message
    const text = props.item.parts
      .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim()

    // Model identity is shown, never inferred. A turn that silently ran under a
    // different model than approved must be visible — the "silent fallback"
    // complaint ux-research.md §3 adopted from kilocode.
    const detail = [message.modelID, message.providerID].filter(Boolean).join(" · ")

    return (
      <EntryFrame api={props.api} glyph={glyphs.dot} label="ranex" detail={detail}>
        <text fg={theme().text} wrapMode="word">
          {text}
        </text>
      </EntryFrame>
    )
  },
}
