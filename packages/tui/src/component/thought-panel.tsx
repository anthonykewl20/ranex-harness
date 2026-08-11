import type { RGBA } from "@opentui/core"
import { createMemo, createSignal, Show } from "solid-js"
import { detectGlyphs } from "../theme/glyphs"

const glyphs = detectGlyphs()

/**
 * The framed thinking panel, from the owner's mockup.
 *
 * Rendered directly by `routes/session`, not through a slot. That machinery
 * existed to keep upstream files untouched, and the rule was justified by merge
 * cost — but this fork owns its UI and does not carry upstream's UI changes, so
 * the cost was imaginary and the indirection bought nothing except distance
 * between the rendering and its only caller.
 *
 * What the mockup asks for and a terminal can give: a bordered panel, a header
 * carrying the elapsed time, a collapse control on the right, and the body set
 * inside the frame so the block reads as one object rather than as loose lines.
 *
 * What it asks for and a terminal cannot: the gradient behind the panel and the
 * glow around it. A cell has one foreground and one background — there is no
 * value between two colours to fade through. The frame carries the structure the
 * gradient was carrying, which is what the mockup was actually organising with.
 *
 * Emoji icons are deliberately not copied. They render at inconsistent widths
 * across terminals, vanish under the ASCII fallback, and opencode #27734 is a
 * user asking, in capitals, for a setting to remove them. The word does the same
 * work and survives NO_COLOR.
 */
export type ThoughtPanelTheme = { border: RGBA; text: RGBA; textMuted: RGBA }

export function ThoughtPanel(props: {
  /**
   * Just the colours it draws with.
   *
   * Not the theme context and not a plugin api: this needs three values, and
   * taking three values means it renders in a test without a provider tree —
   * which is how the panel's behaviour is actually pinned.
   */
  theme: ThoughtPanelTheme
  text: string
  title?: string
  duration?: string
  done: boolean
}) {
  const theme = () => props.theme
  const [open, setOpen] = createSignal(false)

  // The header states what the thought was about, not only how long it took. A
  // duration cannot tell a reader whether to open the block; the first clause
  // can. `title` is upstream's, present only when the provider emits OpenAI's
  // bolded-summary convention, so there is a fallback for everyone else.
  const heading = createMemo(() => {
    const title = props.title?.trim()
    if (title) return title
    const first = props.text.trim().split(/(?<=[.!?])\s|\n/)[0] ?? ""
    const clause = first.trim().replace(/\s+/g, " ")
    if (!clause) return props.done ? "thought" : "thinking"
    return clause.length > 48 ? `${clause.slice(0, 47)}…` : clause
  })

  const body = createMemo(() => props.text.trim())

  return (
    <box
      marginTop={1}
      flexShrink={0}
      border={["left", "top", "right", "bottom"]}
      borderColor={theme().border}
      onMouseUp={() => setOpen((x) => !x)}
    >
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={theme().textMuted} wrapMode="none">
          {open() ? glyphs.down : glyphs.right}
        </text>
        <text fg={theme().text} wrapMode="none">
          <b>Thought</b>
        </text>
        <Show when={props.duration}>
          <text fg={theme().textMuted} wrapMode="none">
            {props.duration}
          </text>
        </Show>
        {/* The heading takes the slack so the control stays pinned right, and
            never wraps: a header that reflows stops being a header. */}
        <text fg={theme().textMuted} flexGrow={1} flexShrink={1} wrapMode="none">
          {heading()}
        </text>
        <text fg={theme().textMuted} flexShrink={0} wrapMode="none">
          {open() ? "collapse" : "expand"}
        </text>
      </box>
      <Show when={open() && body()}>
        <box paddingLeft={2} paddingRight={1} paddingBottom={1} marginTop={1}>
          <text fg={theme().textMuted} wrapMode="word">
            {body()}
          </text>
        </box>
      </Show>
    </box>
  )
}
