import type { TuiPluginApi } from "@ranex/plugin/tui"
import { createMemo, For } from "solid-js"
import { detectGlyphs } from "../../theme/glyphs"
import { EntryFrame } from "./frame"
import { ENTRIES, } from "./entries"
import { resolveEntry, type TranscriptItem } from "./entry"
import { projectItems } from "./items"
import { cycleDensity, readDensity, shows } from "./density"
import { useBindings } from "../../keymap"

const glyphs = detectGlyphs()

/**
 * An item no entry claimed.
 *
 * Never dropped and never rendered as the nearest familiar kind. An item shown
 * as the wrong kind looks correct, which is the empty-and-reassuring failure
 * this project exists to remove; one shown as `unrendered` is merely ugly.
 */
function Unrendered(props: { api: TuiPluginApi; item: TranscriptItem }) {
  return (
    <EntryFrame api={props.api} glyph={glyphs.warn} label="unrendered" detail={props.item.kind}>
      <text fg={props.api.theme.current.textMuted}>{props.item.id}</text>
    </EntryFrame>
  )
}

/**
 * The transcript body, rendered into the `session_transcript` slot.
 *
 * It does not scroll itself: the slot sits inside the route's scrollbox, which
 * already owns scroll position. CHAT-14 takes ownership of the wheel and of
 * autoscroll release; until then the route's behaviour is unchanged.
 */
export function Transcript(props: { api: TuiPluginApi; session_id: string }) {
  const density = createMemo(() => readDensity(props.api))

  // The title states the current mode, so the palette says what pressing it will
  // change rather than only that something is changeable. A displayed command
  // that does not dispatch is opencode #41732, and the same applies to one whose
  // label does not describe what it does.
  useBindings(() => ({
    commands: [
      {
        name: "transcript.density",
        title: `Transcript density: ${density()}`,
        category: "Ranex",
        namespace: "palette",
        run() {
          props.api.ui.toast({ variant: "info", message: `Transcript density: ${cycleDensity(props.api)}` })
          props.api.ui.dialog.clear()
        },
      },
    ],
    bindings: props.api.tuiConfig.keybinds.get("transcript.density"),
  }))

  const items = createMemo(() => projectItems(props.api, props.session_id).filter((item) => shows(density(), item.kind)))

  return (
    <box flexDirection="column">
      <For each={items()}>
        {(item) => {
          const entry = resolveEntry(ENTRIES, item)
          if (!entry) return <Unrendered api={props.api} item={item} />
          // The registry guarantees kind matches, so the payload the entry
          // receives is the one its renderer declared. `assertEntries` is what
          // makes that true at construction rather than by convention.
          return entry.render({ api: props.api, item } as never)
        }}
      </For>
    </box>
  )
}
