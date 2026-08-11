import { createSignal } from "solid-js"
import { detectGlyphs } from "../../../theme/glyphs"
import { EntryFrame } from "../chrome"
import type { TranscriptEntry } from "../entry"

const glyphs = detectGlyphs()

/**
 * CHAT-05 — the reasoning entry.
 *
 * Upstream already wants to label reasoning by content and only manages it for
 * one vendor: `context/thinking.ts:12` recovers a title by matching
 * `**Bold**\n\n` against the prose, which its own comment attributes to OpenAI's
 * Responses API. Every other provider falls through to `Thought: 458ms`, which
 * is what this harness shows under DeepSeek.
 *
 * ADR-018 banned exactly that pattern for verdict causes — *the wording is not
 * an interface*. So the label here is derived by a documented rule that does not
 * depend on one vendor's markdown, and the duration is never the only label.
 */
export function reasoningLabel(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return "no summary"

  // A bolded title block if the provider sent one, otherwise the first clause.
  // Both are documented rules over structure we can see, not guesses about intent.
  const bold = trimmed.match(/^\*\*([^*\n]+)\*\*/)
  const first = bold ? bold[1] : (trimmed.split(/(?<=[.!?])\s|\n/)[0] ?? trimmed)
  const label = first.trim().replace(/\s+/g, " ")
  return label.length > 72 ? `${label.slice(0, 71)}…` : label
}

export const ReasoningEntry: TranscriptEntry<"reasoning"> = {
  id: "ranex.transcript.reasoning",
  kind: "reasoning",
  order: 300,
  render: (props) => {
    const [open, setOpen] = createSignal(false)
    const theme = () => props.api.theme.current
    const body = () => {
      const part = props.item.part
      return "text" in part && typeof part.text === "string" ? part.text : ""
    }

    return (
      <box onMouseDown={() => setOpen((x) => !x)}>
        <EntryFrame
          api={props.api}
          glyph={open() ? glyphs.down : glyphs.right}
          label="thought"
          detail={reasoningLabel(body())}
        >
          {open() ? (
            <text fg={theme().textMuted} wrapMode="word">
              {body()}
            </text>
          ) : null}
        </EntryFrame>
      </box>
    )
  },
}
