import { Show } from "solid-js"
import { EntryFrame } from "../frame"
import { Markdown } from "../render/markdown"
import type { TranscriptEntry } from "../entry"

/**
 * CHAT-04 — the assistant entry.
 *
 * **The model goes at the end, not the top.** Above the answer it is a header
 * you read before you know whether you care, repeated identically down the whole
 * screen — and it put the provider id, the literal string `opencode`, on every
 * reply. Underneath, it is a receipt: what ran, on what, for how long, available
 * exactly when the answer has been read and the question becomes worth asking.
 *
 * The information is not dropped, which matters. `ux-research.md` §3 adopted
 * kilocode's "silent fallback to default model" complaint: a turn that ran under
 * a different model must be visible, and it still is — every turn states its
 * own, once, where it does not compete with the answer.
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

    // Only for a finished turn. A duration printed while the answer is still
    // streaming would be wrong every frame until the last one.
    const elapsed = () => {
      const done = message.time?.completed
      const started = message.time?.created
      if (!done || !started || done < started) return
      return `${((done - started) / 1000).toFixed(1)}s`
    }

    return (
      <EntryFrame api={props.api} label="ranex" tone={props.api.theme.current.primary}>
        <Markdown content={text} />
        <Show when={elapsed()}>
          <box flexDirection="row" gap={1} marginTop={1} flexShrink={0}>
            <text fg={theme().textMuted} wrapMode="none">
              {message.agent}
            </text>
            <text fg={theme().textMuted} wrapMode="none">
              {`· ${message.modelID} · ${elapsed()}`}
            </text>
          </box>
        </Show>
      </EntryFrame>
    )
  },
}
