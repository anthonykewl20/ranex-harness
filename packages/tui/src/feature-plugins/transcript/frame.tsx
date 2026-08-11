import type { TuiPluginApi } from "@ranex/plugin/tui"
import { Show, type JSXElement } from "solid-js"

/**
 * The shared chrome, so entries look like one surface rather than six.
 *
 * The label line lives here and nowhere else. An entry that wants a different
 * one is telling you the label is wrong; change it here for all of them.
 *
 * **Content starts at column 0.** There is no decorative left rule and no
 * persistent indent on a body, because a gutter is copied along with the text —
 * claude-code #75221 is an open request for an option to strip one, and copy is
 * the operation operators perform most. Identity goes above, not beside.
 */
export function EntryFrame(props: {
  api: TuiPluginApi
  glyph?: string
  label: string
  detail?: string
  outcome?: string
  /**
   * Fills the entry's **label row** with the panel colour, marking it as the
   * human's turn.
   *
   * This is how the two sides are told apart, and it is deliberately not how
   * opencode does it. A per-message left bar colours one column, is loud, and is
   * copied along with the text (claude-code #75221). A label alone was not
   * enough — `→ you` and `· ranex` are the same shape two lines apart, which is
   * what the owner reported after running it.
   *
   * Filling the label row rather than the whole entry is deliberate. A
   * full-bleed block put body text hard against the tint's left edge while every
   * other entry sat at column 0, so the two no longer lined up — and padding it
   * back would have put spaces in front of every copied line
   * (claude-code #75221). A filled bar spans the width, is unmissable while
   * scrolling, and leaves the body on the same left edge as everything else.
   *
   * It costs the copy buffer nothing — a background colour is not part of the
   * text — and survives NO_COLOR losing nothing, because the label still spells
   * whose turn it is.
   */
  tinted?: boolean
  children?: JSXElement
}) {
  const theme = () => props.api.theme.current

  return (
    <box gap={0} marginTop={1} flexShrink={0}>
      <box
        flexDirection="row"
        gap={1}
        backgroundColor={props.tinted ? theme().backgroundPanel : undefined}
      >
        <Show when={props.glyph}>
          <text fg={theme().textMuted}>{props.glyph}</text>
        </Show>
        <text fg={theme().text}>
          <b>{props.label}</b>
        </text>
        <Show when={props.detail}>
          {/* One line, always. A label that wraps stops being a label: it
              reflows the row, pushes the outcome column out of alignment, and
              turns a one-line summary into a paragraph competing with the body
              it was supposed to summarise. Clipping is the honest failure — the
              full text is one keypress away in the expanded region. */}
          <text fg={theme().textMuted} flexGrow={1} flexShrink={1} wrapMode="none">
            {props.detail}
          </text>
        </Show>
        <Show when={props.outcome}>
          <text fg={theme().textMuted} flexShrink={0} wrapMode="none">
            {props.outcome}
          </text>
        </Show>
      </box>
      {props.children}
    </box>
  )
}

