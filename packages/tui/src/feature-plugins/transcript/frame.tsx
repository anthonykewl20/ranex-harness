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
  children?: JSXElement
}) {
  const theme = () => props.api.theme.current

  return (
    <box gap={0} marginTop={1}>
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

