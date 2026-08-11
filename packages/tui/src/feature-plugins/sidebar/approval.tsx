import type { TuiPlugin, TuiPluginApi } from "@ranex/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"

const id = "internal:sidebar-approval"

type ApprovalData =
  | { readonly state: "unread"; readonly why: string }
  | { readonly state: "read"; readonly level: "A" | "B" | "C"; readonly expiresAt: string }

function View(props: { api: TuiPluginApi; data: ApprovalData }) {
  const theme = () => props.api.theme.current

  if (props.data.state === "unread") {
    return (
      <box>
        <text fg={theme().text}>
          <b>Approval</b>
        </text>
        <text fg={theme().warning}>unavailable — no channel</text>
        <text fg={theme().textMuted}>{props.data.why}</text>
      </box>
    )
  }

  return (
    <box>
      <text fg={theme().text}>
        <b>Approval {props.data.level}</b>
      </text>
      <text fg={theme().textMuted}>expires {props.data.expiresAt}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 900,
    slots: {
      sidebar_content() {
        const data: ApprovalData = {
          state: "unread",
          why: "BOARD-01 / ADR-019",
        }
        return <View api={api} data={data} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
