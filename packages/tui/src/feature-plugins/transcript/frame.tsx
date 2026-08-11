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
   * Draws a full-width rule above the entry, marking the start of a turn.
   *
   * This is how the two sides are told apart, and it is deliberately not how
   * opencode does it. A per-message left bar colours every line of every
   * message, which is loud, and it is copied along with the text
   * (claude-code #75221). A rule is drawn once per exchange, touches no line of
   * content, and chunks the transcript into turns you can find by eye while
   * scrolling — which is the thing a colour on the left never gave you.
   */
  divider?: boolean
  children?: JSXElement
}) {
  const theme = () => props.api.theme.current

  return (
    <box gap={0} marginTop={1}>
      <Show when={props.divider}>
        <text fg={theme().border} wrapMode="none">
          {"─".repeat(200)}
        </text>
      </Show>
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

