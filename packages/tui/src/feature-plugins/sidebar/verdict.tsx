import type { TuiPlugin, TuiPluginApi } from "@ranex/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"

const id = "internal:sidebar-verdict"

type VerdictData =
  | { readonly state: "unread"; readonly why: string }
  | { readonly state: "read"; readonly verdict: "PASS" | "FAIL"; readonly failingRule?: string }

function View(props: { api: TuiPluginApi; data: VerdictData }) {
  const theme = () => props.api.theme.current

  if (props.data.state === "unread") {
    return (
      <box>
        <text fg={theme().text}>
          <b>Verdict</b>
        </text>
        <text fg={theme().warning}>unavailable — no channel</text>
        <text fg={theme().textMuted}>{props.data.why}</text>
      </box>
    )
  }

  return (
    <box>
      <text fg={theme().text}>
        <b>Verdict</b>
      </text>
      <text fg={props.data.verdict === "PASS" ? theme().success : theme().error}>{props.data.verdict}</text>
      <text fg={theme().textMuted}>{props.data.failingRule ?? "no failing rule"}</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 700,
    slots: {
      sidebar_content() {
        const data: VerdictData = {
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
