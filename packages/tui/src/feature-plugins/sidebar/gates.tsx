import type { TuiPlugin, TuiPluginApi } from "@ranex/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { For, Show } from "solid-js"

const id = "internal:sidebar-gates"

type GatesData =
  | { readonly state: "unread"; readonly why: string }
  | {
      readonly state: "read"
      readonly counts: { readonly passed: number; readonly failed: number; readonly absent: number }
      readonly failingCauses: readonly string[]
    }

function View(props: { api: TuiPluginApi; data: GatesData }) {
  const theme = () => props.api.theme.current

  if (props.data.state === "unread") {
    return (
      <box>
        <text fg={theme().text}>
          <b>Gates</b>
        </text>
        <text fg={theme().warning}>unavailable — no channel</text>
        <text fg={theme().textMuted}>{props.data.why}</text>
      </box>
    )
  }

  return (
    <box>
      <text fg={theme().text}>
        <b>Gates</b>
      </text>
      <text fg={theme().textMuted}>
        {props.data.counts.passed} pass · {props.data.counts.failed} fail · {props.data.counts.absent} absent
      </text>
      <Show when={props.data.failingCauses.length > 0}>
        <For each={props.data.failingCauses}>{(cause) => <text fg={theme().error}>{cause}</text>}</For>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 800,
    slots: {
      sidebar_content() {
        const data: GatesData = {
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
