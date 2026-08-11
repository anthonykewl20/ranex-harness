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
   * Fills the entry's whole block with the panel colour, marking it as the
   * human's turn.
   *
   * This is how the two sides are told apart, and it is deliberately not how
   * opencode does it. A per-message left bar colours one column, is loud, and is
   * copied along with the text (claude-code #75221). A label alone was not
   * enough — `→ you` and `· ranex` are the same shape two lines apart, which is
   * what the owner reported after running it.
   *
   * A filled block is unmissable while scrolling, gives the transcript an
   * alternating rhythm, and costs the copy buffer nothing: a background colour
   * is not part of the text. It also survives NO_COLOR losing nothing, because
   * the label still spells whose turn it is.
   */
  tinted?: boolean
  children?: JSXElement
}) {
  const theme = () => props.api.theme.current

  return (
    <box
      gap={0}
      marginTop={1}
      flexShrink={0}
      backgroundColor={props.tinted ? theme().backgroundPanel : undefined}
      // Vertical padding only. Horizontal padding would put spaces in front of
      // every line of the body, which is the copy defect the tint exists to
      // avoid (claude-code #75221) — a full-width block is already unmistakable
      // without indenting its content.
      paddingTop={props.tinted ? 1 : 0}
      paddingBottom={props.tinted ? 1 : 0}
    >
      <box flexDirection="row" gap={1}>
        <Show when={props.glyph}>
          <text fg={theme().textMuted}>{props.glyph}</text>
        </Show>
        <text fg={theme().text}>
          <b>{props.label}</b>
        </text>
        <Show when={props.detail}>
          <text fg={theme().textMuted} flexGrow={1}>
            {props.detail}
          </text>
        </Show>
        <Show when={props.outcome}>
          <text fg={theme().textMuted} flexShrink={0}>
            {props.outcome}
          </text>
        </Show>
      </box>
      {props.children}
    </box>
  )
}

