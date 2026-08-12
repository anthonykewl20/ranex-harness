import type { PromptInfo } from "../../prompt/history"
import type { GlyphSet } from "../../theme/glyphs"
import type { Theme } from "../../theme"
import { For, Show } from "solid-js"

export type AttachmentStripProps = {
  parts: PromptInfo["parts"]
  selected: number
  expanded: boolean
  glyphs: GlyphSet
  theme: Theme
  onSelect(index: number): void
  onExpand(): void
}

export function AttachmentStrip(props: AttachmentStripProps) {
  const entries = () => props.parts.flatMap((part, index) => part.type === "text" || part.type === "file" ? [{ index, label: attachmentLabel(part, props.glyphs) }] : [])
  const visible = () => entries().slice(0, props.expanded ? 6 : 3)
  const hidden = () => Math.max(0, entries().length - visible().length)

  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={visible()}>
        {(entry) => (
          <box flexDirection="row" justifyContent="space-between" onMouseUp={() => props.onSelect(entry.index)}>
            <text fg={entry.index === props.selected ? props.theme.text : props.theme.textMuted} wrapMode="none">
              {entry.index === props.selected ? `${props.glyphs.right} ` : "  "}{entry.label}
            </text>
            <Show when={entry.index === props.selected}>
              <text fg={props.theme.textMuted}>alt+backspace remove</text>
            </Show>
          </box>
        )}
      </For>
      <Show when={hidden() > 0}>
        <box onMouseUp={props.onExpand}><text fg={props.theme.textMuted}>+{hidden()} more {props.glyphs.dot} alt+e {props.expanded ? "collapse" : "expand"}</text></box>
      </Show>
      <Show when={props.expanded && entries().length > 3 && hidden() === 0}>
        <box onMouseUp={props.onExpand}><text fg={props.theme.textMuted}>alt+e collapse</text></box>
      </Show>
    </box>
  )
}

function attachmentLabel(part: PromptInfo["parts"][number], glyphs: GlyphSet) {
  if (part.type === "text") {
    const lines = (part.text.match(/\n/g)?.length ?? 0) + 1
    const kind = part.metadata?.kind === "svg" ? "svg" : "paste"
    return `${kind} ${glyphs.dot} ${lines} ${lines === 1 ? "line" : "lines"}`
  }
  if (part.type === "file") {
    const kind = part.mime === "application/pdf" ? "pdf" : part.mime === "image/svg+xml" ? "svg" : part.mime.startsWith("image/") ? "image" : "file"
    const name = part.filename ?? (part.source?.type === "file" ? part.source.path : undefined) ?? part.mime
    const bytes = dataUrlBytes(part.url)
    return `${kind} ${glyphs.dot} ${name}${bytes === undefined ? "" : ` ${formatBytes(bytes)}`}`
  }
  return `agent ${glyphs.dot} ${part.name}`
}

function dataUrlBytes(url: string) {
  const marker = ";base64,"
  const index = url.indexOf(marker)
  if (index === -1) return
  const length = url.length - index - marker.length
  return Math.max(0, Math.floor((length * 3) / 4) - (url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0))
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}b`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}k`
  return `${(bytes / (1024 * 1024)).toFixed(1)}m`
}
