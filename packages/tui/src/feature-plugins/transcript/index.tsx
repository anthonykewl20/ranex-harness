import type { TuiPlugin, TuiPluginApi } from "@ranex/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { Transcript } from "./chrome"

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
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
