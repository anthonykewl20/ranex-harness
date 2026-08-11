import type { TuiPlugin, TuiPluginApi } from "@ranex/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { useClipboard } from "../../context/clipboard"
import { Locale } from "../../util/locale"

const id = "internal:sidebar-subject"

type SubjectData =
  | { readonly state: "unread"; readonly why: string }
  | {
      readonly state: "read"
      readonly subject: { readonly digest: string; readonly lane: string; readonly worktree: string }
    }

function View(props: { api: TuiPluginApi; data: SubjectData }) {
  const theme = () => props.api.theme.current
  const clipboard = useClipboard()

  if (props.data.state === "unread") {
    return (
      <box>
        <text fg={theme().text}>
          <b>Subject</b>
        </text>
        <text fg={theme().warning}>unavailable — no channel</text>
        <text fg={theme().textMuted}>{props.data.why}</text>
      </box>
    )
  }

  const subject = props.data.subject

  return (
    <box>
      <text fg={theme().text}>
        <b>Subject</b>
      </text>
      <text fg={theme().textMuted} wrapMode="none" onMouseDown={() => void clipboard.write?.(subject.digest)}>
        digest {Locale.truncateMiddle(subject.digest, 30)}
      </text>
      <text fg={theme().textMuted}>lane {subject.lane}</text>
      <text
        fg={theme().textMuted}
        wrapMode="none"
        onMouseDown={() => void clipboard.write?.(subject.worktree)}
      >
        worktree {Locale.truncateLeft(subject.worktree, 27)}
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 600,
    slots: {
      sidebar_content() {
        const data: SubjectData = {
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
