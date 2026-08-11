import type { TuiPlugin, TuiPluginApi } from "@ranex/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { Transcript } from "./chrome"
import { StatusRow } from "./status-view"

const id = "internal:transcript"

/**
 * CHAT-01 / ADR-022 — the Ranex transcript.
 *
 * It fills `session_transcript`, one of exactly two slots the ADR permits in
 * `routes/session`. The route keeps every piece of live behaviour it owns —
 * session lifecycle, the permission reply path, subagents, retries — and this
 * supplies the pixels. Deleting this plugin returns the screen to upstream's
 * rendering, because the slot carries that as its fallback.
 */
const tui: TuiPlugin = async (api: TuiPluginApi) => {
  api.slots.register({
    order: 100,
    slots: {
      session_transcript(_ctx, props) {
        return <Transcript api={api} session_id={props.session_id} />
      },
      // `app_bottom` already existed at the app level, so the status row needed
      // no new opening in the session route.
      app_bottom() {
        return <StatusRow api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
