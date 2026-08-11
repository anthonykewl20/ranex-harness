import type { TuiPlugin, TuiPluginApi } from "@ranex/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"

const id = "internal:sidebar-attempts"

type AttemptsData =
  | { readonly state: "unread"; readonly why: string }
  | { readonly state: "read"; readonly attempts: number; readonly stopAt: 3 }

function View(props: { api: TuiPluginApi; data: AttemptsData }) {
  const theme = () => props.api.theme.current

  if (props.data.state === "unread") {
    return (
      <box>
        <text fg={theme().text}>
          <b>Attempts</b>
        </text>
        <text fg={theme().warning}>unavailable — no channel</text>
        <text fg={theme().textMuted}>{props.data.why}</text>
      </box>
    )
  }

  return (
    <box>
      <text fg={theme().text}>
        <b>Attempts</b>
      </text>
      <text fg={props.data.attempts >= props.data.stopAt ? theme().error : theme().textMuted}>
        {props.data.attempts} / {props.data.stopAt} · {Math.max(0, props.data.stopAt - props.data.attempts)} remaining
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 1000,
    slots: {
      sidebar_content() {
        const data: AttemptsData = {
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
