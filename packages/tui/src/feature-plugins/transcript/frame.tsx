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
   * Renders the entry as a panel with an accent bar down its left edge.
   *
   * This is the human's turn, and the shape is the one the owner asked for after
   * seeing the alternatives: a filled block with a coloured rule and inset text,
   * so the two sides alternate unmistakably while scrolling.
   *
   * It does indent the body, which is what claude-code #75221 is about — a
   * gutter is copied along with the text. That objection is answered by scope
   * rather than dismissed: this applies to the message the operator wrote, which
   * they already have. The **assistant's** body, the text people actually copy
   * into bug reports and commits, stays flush at column 0, and
   * `transcript-presentation.test.tsx` holds it there.
   */
  tinted?: boolean
  /**
   * Renders the label at reduced weight, for entries that are not the point.
   *
   * Tool calls and reasoning are what the model did on the way to an answer;
   * the answer is the reason the operator is reading. Given identical weight
   * they compete, and a screen of a dozen bold labels buries the one thing
   * worth reading — which is what the owner saw. Receding them is not
   * decoration, it is the hierarchy doing its job.
   */
  quiet?: boolean
  children?: JSXElement
}) {
  const theme = () => props.api.theme.current

  return (
    <box
      gap={0}
      marginTop={1}
      flexShrink={0}
      border={props.tinted ? ["left"] : undefined}
      borderColor={props.tinted ? theme().accent : undefined}
      backgroundColor={props.tinted ? theme().backgroundPanel : undefined}
      paddingLeft={props.tinted ? 2 : 0}
      paddingRight={props.tinted ? 1 : 0}
      paddingTop={props.tinted ? 1 : 0}
      paddingBottom={props.tinted ? 1 : 0}
    >
      <box flexDirection="row" gap={1}>
        <Show when={props.glyph}>
          <text fg={theme().textMuted}>{props.glyph}</text>
        </Show>
        {props.quiet ? (
          <text fg={theme().textMuted} wrapMode="none">
            {props.label}
          </text>
        ) : (
          <text fg={theme().text} wrapMode="none">
            <b>{props.label}</b>
          </text>
        )}
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

