import type { TuiPluginApi } from "@ranex/plugin/tui"
import { createMemo, For, Show, type JSXElement } from "solid-js"
import { detectGlyphs } from "../../theme/glyphs"
import { ENTRIES, } from "./entries"
import { resolveEntry, type TranscriptItem } from "./entry"
import { projectItems } from "./items"

const glyphs = detectGlyphs()

/**
 * The shared chrome, so entries look like one surface rather than six.
 *
 * The label line lives here and nowhere else. An entry that wants a different
 * one is telling you the label is wrong; change it here for all of them.
 *
 * **Content starts at column 0.** There is no decorative left rule and no
 * persistent indent on a body, because a gutter is copied along with the text —
 * claude-code #75221 is an open request for an option to strip one, and copy is
 * the operation operators perform most. Identity goes above, not beside.
 */
export function EntryFrame(props: {
  api: TuiPluginApi
  glyph?: string
  label: string
  detail?: string
  outcome?: string
  children?: JSXElement
}) {
  const theme = () => props.api.theme.current

  return (
    <box gap={0} marginTop={1}>
      <box flexDirection="row" gap={1}>
        <Show when={props.glyph}>
          <text fg={theme().textMuted}>{props.glyph}</text>
        </Show>
        <text fg={theme().text}>
          <b>{props.label}</b>
        </text>
        <Show when={props.detail}>
          <text fg={theme().textMuted} flexGrow={1}>
            {props.detail}
          </text>
        </Show>
        <Show when={props.outcome}>
          <text fg={theme().textMuted} flexShrink={0}>
            {props.outcome}
          </text>
        </Show>
      </box>
      {props.children}
    </box>
  )
}

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
  const items = createMemo(() => projectItems(props.api, props.session_id))

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
