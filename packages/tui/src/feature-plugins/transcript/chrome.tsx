import type { TuiPluginApi } from "@ranex/plugin/tui"
import { createMemo, For } from "solid-js"
import { detectGlyphs } from "../../theme/glyphs"
import { EntryFrame } from "./frame"
import { ENTRIES, } from "./entries"
import { resolveEntry, type TranscriptItem } from "./entry"
import { createProjection } from "./items"
import { cycleDensity, readDensity, shows } from "./density"
import { useBindings } from "../../keymap"
import { useClipboard } from "../../context/clipboard"
import { copyText, lastCopyable } from "./copy"

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
 * It does not scroll itself, and must not. The slot sits inside the route's
 * `<scrollbox>`, which owns scroll position, sticky-to-bottom, acceleration and
 * the ref every scroll command drives. CHAT-14's requirements — the wheel
 * scrolls the transcript, and autoscroll releases when the reader scrolls up —
 * are that scrollbox's `stickyScroll` behaviour, already correct upstream.
 *
 * An earlier revision wrapped the scrollbox instead of sitting inside it, and
 * `replace` therefore deleted it. Nothing failed; long conversations simply
 * could not be scrolled. `transcript-slots.test.tsx` now pins the placement.
 */
export function Transcript(props: { api: TuiPluginApi; session_id: string }) {
  const density = createMemo(() => readDensity(props.api))
  // One projection per mounted transcript, so item identity survives renders.
  const project = createProjection()

  // The title states the current mode, so the palette says what pressing it will
  // change rather than only that something is changeable. A displayed command
  // that does not dispatch is opencode #41732, and the same applies to one whose
  // label does not describe what it does.
  const clipboard = useClipboard()

  useBindings(() => ({
    commands: [
      {
        name: "transcript.copy",
        title: "Copy the last message",
        category: "Ranex",
        namespace: "palette",
        async run() {
          const item = lastCopyable(items())
          const text = item ? copyText(item) : undefined
          // Never report success for an empty copy — claude-code #56298 is
          // "Copy message" silently writing an empty string.
          if (!text) {
            props.api.ui.toast({ variant: "info", message: "Nothing to copy" })
            props.api.ui.dialog.clear()
            return
          }
          if (!clipboard.write) {
            props.api.ui.toast({ variant: "error", message: "Clipboard unavailable" })
            props.api.ui.dialog.clear()
            return
          }
          await clipboard.write(text)
          props.api.ui.toast({ variant: "info", message: `Copied ${text.length} characters` })
          props.api.ui.dialog.clear()
        },
      },
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
    // `transcript.copy` intentionally ships with no default binding: crush's
    // shortcut-collision complaint (ux-research.md §7) is what happens when a
    // tool claims keys users already own. It is reachable from the palette and
    // bindable in config, which is keymap-as-data doing its job.
  }))

  const items = createMemo(() => project(props.api, props.session_id).filter((item) => shows(density(), item.kind)))

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
