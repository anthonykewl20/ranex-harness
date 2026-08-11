import type { TuiPluginApi } from "@ranex/plugin/tui"
import type { BoardData } from "./pane"

/**
 * Owner mode is a projection of the board's input, never another data path.
 * Until translation rules are decided, machine wording crosses this boundary
 * unchanged so distinct states cannot be softened into one label.
 */
export function operatorWording(value: string) {
  return value
}

export function OwnerView(props: { readonly api: TuiPluginApi; readonly data: BoardData }) {
  const theme = () => props.api.theme.current

  if (props.data.state === "unread") {
    return (
      <box gap={1}>
        <text fg={theme().text}>
          <b>There is nothing to decide yet.</b>
        </text>
        <text fg={theme().warning}>No verdict was read.</text>
        <text fg={theme().textMuted}>{props.data.why}</text>
        <box>
          <text fg={theme().text}>Ask the operator to judge from the CLI:</text>
          <text fg={theme().textMuted}>
            {" "}
            ranex gate evaluate {"<ref>"}
          </text>
        </box>
      </box>
    )
  }

  return (
    <box gap={1}>
      <text fg={theme().text}>
        <b>One decision</b>
      </text>
      <box>
        <text fg={theme().text}>verdict {operatorWording(props.data.record.verdict)}</text>
        <text fg={theme().textMuted}>subject {operatorWording(props.data.record.subject_digest)}</text>
      </box>
      <text fg={theme().warning}>Plain-language translation rules are not decided yet.</text>
      <text fg={theme().textMuted}>Operator wording is shown unchanged.</text>
    </box>
  )
}
