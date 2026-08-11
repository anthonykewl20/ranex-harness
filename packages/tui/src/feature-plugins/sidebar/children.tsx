import type { TuiPlugin, TuiPluginApi } from "@ranex/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { For } from "solid-js"

const id = "internal:sidebar-children"

type ChildrenData =
  | { readonly state: "unread"; readonly why: string }
  | {
      readonly state: "read"
      readonly children: readonly { readonly id: string; readonly status: string }[]
    }

function View(props: { api: TuiPluginApi; data: ChildrenData }) {
  const theme = () => props.api.theme.current

  if (props.data.state === "unread") {
    return (
      <box>
        <text fg={theme().text}>
          <b>Children</b>
        </text>
        <text fg={theme().textMuted}>no batch running</text>
        <text fg={theme().warning}>unavailable — no channel</text>
        <text fg={theme().textMuted}>{props.data.why}</text>
      </box>
    )
  }

  if (props.data.children.length === 0) {
    return (
      <box>
        <text fg={theme().text}>
          <b>Children</b>
        </text>
        <text fg={theme().textMuted}>no batch running</text>
      </box>
    )
  }

  return (
    <box>
      <text fg={theme().text}>
        <b>Children</b>
      </text>
      <For each={props.data.children}>
        {(child) => <text fg={theme().textMuted}>{child.id} · {child.status}</text>}
      </For>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 1200,
    slots: {
      sidebar_content() {
        const data: ChildrenData = {
          state: "unread",
          why: "BOARD-01 / ADR-019; child status awaits BOARD-17/18",
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
