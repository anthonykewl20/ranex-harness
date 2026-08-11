import type { TuiPluginApi } from "@ranex/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, Show } from "solid-js"
import { useRoute } from "../../context/route"
import { fitStatus, statusLabel } from "./status"

/**
 * CHAT-12 — one row, and every field on it read once.
 *
 * claude-code #74355, #53712 and #33823 are all the same defect: a status line
 * disagreeing with the command that reports the same figure, because each read
 * the underlying state separately. Everything here comes from one read of the
 * plugin state, in one memo, so there is no second read to disagree with.
 *
 * It renders into `app_bottom`, an app-level slot that already existed. No new
 * opening was needed for this at all.
 */
export function StatusRow(props: { api: TuiPluginApi }) {
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const theme = () => props.api.theme.current

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  // Only what no other row already says, and only while it is true.
  //
  // The route's own footer already carries the directory, the context figure and
  // the command hint. Adding session title and branch beneath it produced a
  // second permanent row saying things the screen said twice — the clutter the
  // owner reported on first run. What is genuinely missing is the live state, so
  // that is all this row is, and when the session is idle it is nothing at all.
  const fields = createMemo(() => {
    const id = sessionID()
    if (!id) return []
    const status = props.api.state.session.status(id)
    if (!status || status.type === "idle") return []
    return [statusLabel(status)]
  })

  // The row reserves no space when it has nothing to say — claude-code #83402
  // is a status line holding a blank row open in fullscreen.
  return (
    <Show when={fields().length > 0}>
      <box flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={theme().textMuted} wrapMode="none">
          {fitStatus(fields(), Math.max(0, dimensions().width - 2))}
        </text>
      </box>
    </Show>
  )
}
