import { detectGlyphs } from "../../../theme/glyphs"
import { EntryFrame } from "../frame"
import { Markdown } from "../render/markdown"
import type { TranscriptEntry } from "../entry"

const glyphs = detectGlyphs()

/**
 * CHAT-04 — the assistant entry.
 *
 * The label line carries agent and model; the body is markdown, rendered with
 * the generated theme's syntax palette. opencode #15141 (headings with no
 * hierarchy) and #38828 (markdown shown as raw text) are what a transcript
 * looks like without this.
 */
export const AssistantEntry: TranscriptEntry<"assistant"> = {
  id: "ranex.transcript.assistant",
  kind: "assistant",
  order: 200,
  render: (props) => {
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
        <Markdown content={text} />
      </EntryFrame>
    )
  },
}
