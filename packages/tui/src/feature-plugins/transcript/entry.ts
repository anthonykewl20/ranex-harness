import type { TuiPluginApi } from "@ranex/plugin/tui"
import type { AssistantMessage, Part, ReasoningPart, ToolPart, UserMessage } from "@ranex/sdk/v2"
import type { JSXElement } from "solid-js"

/**
 * The contract every transcript entry implements. CHAT-03..CHAT-09.
 *
 * This exists so entries can be built in parallel without fighting over one
 * file: an entry is one module plus one line in `entries/index.ts`, and it never
 * edits the chrome, another entry, or anything upstream owns. It is the board's
 * pane pattern (`feature-plugins/board/pane.tsx`, commit 656fdd4815) with one
 * correction — the board sorts by `order` but nothing rejects two panes claiming
 * the same one, so a duplicate silently reorders it. Here that throws.
 */

/**
 * A blocker is declared structurally rather than imported.
 *
 * The permission and question requests live behind `routes/session`, which owns
 * the reply path and keeps it (ADR-022: rendering moves, authority does not).
 * An entry renders what it is given and cannot reach the decider, and this
 * declaration is the seam that keeps that true.
 */
export type TranscriptBlocker = {
  readonly id: string
  readonly title: string
  readonly body?: string
}

/**
 * What the transcript shows, as a closed set.
 *
 * `id` is stable per item and is what streaming appends key on. It is not the
 * entry's id — one entry renders many items.
 */
export type TranscriptItem =
  | { readonly kind: "user"; readonly id: string; readonly message: UserMessage; readonly parts: readonly Part[] }
  | {
      readonly kind: "assistant"
      readonly id: string
      readonly message: AssistantMessage
      readonly parts: readonly Part[]
      /**
       * Set only when this turn ran under a different model than the turn
       * before it. Absent is the common case and renders nothing — the model is
       * not repeated down the screen.
       */
      readonly modelChange?: string
    }
  | { readonly kind: "reasoning"; readonly id: string; readonly part: ReasoningPart; readonly message: AssistantMessage }
  | { readonly kind: "tool"; readonly id: string; readonly part: ToolPart; readonly message: AssistantMessage }
  | { readonly kind: "permission"; readonly id: string; readonly request: TranscriptBlocker }
  | { readonly kind: "error"; readonly id: string; readonly why: string }

export type TranscriptItemKind = TranscriptItem["kind"]

export type TranscriptEntryProps<K extends TranscriptItemKind> = {
  readonly api: TuiPluginApi
  readonly item: Extract<TranscriptItem, { kind: K }>
  /** Width of the shared label column, measured across the visible transcript. */
  readonly labelWidth?: number
}

export type TranscriptEntry<K extends TranscriptItemKind = TranscriptItemKind> = {
  /** Stable, namespaced, and unique across the registry. */
  readonly id: string
  /** The one item kind this entry renders. */
  readonly kind: K
  /**
   * Sort key, spaced by 100. Entries render in ascending order, so the
   * registry's array order is not load-bearing: git takes both sides of an array
   * append with no conflict marker, and two entries added concurrently would
   * otherwise merge clean and then silently reorder the transcript.
   */
  readonly order: number
  readonly render: (props: TranscriptEntryProps<K>) => JSXElement
}

/**
 * The heterogeneous form the registry holds. A union of the per-kind
 * specialisations rather than a widened one, so an entry cannot be registered
 * against a kind whose payload its renderer does not accept.
 */
export type AnyTranscriptEntry = { [K in TranscriptItemKind]: TranscriptEntry<K> }[TranscriptItemKind]

/**
 * Rejects a registry that would render wrongly, at construction.
 *
 * Two entries claiming one `order`, or one `id`, or one `kind`, are all merge
 * artefacts rather than intentions — nobody writes them on purpose, and each
 * produces a transcript that is wrong for reasons nobody can see. Failing here
 * turns a silent reorder into a startup error naming both sides.
 */
export function assertEntries(entries: readonly AnyTranscriptEntry[]): readonly AnyTranscriptEntry[] {
  const seen = { id: new Map<string, string>(), order: new Map<number, string>(), kind: new Map<string, string>() }
  for (const entry of entries) {
    const clashes = [
      seen.id.get(entry.id) && `id ${entry.id}`,
      seen.order.get(entry.order) && `order ${entry.order}`,
      seen.kind.get(entry.kind) && `kind ${entry.kind}`,
    ].filter((clash): clash is string => Boolean(clash))
    if (clashes.length > 0) {
      const other = seen.id.get(entry.id) ?? seen.order.get(entry.order) ?? seen.kind.get(entry.kind)
      throw new Error(`transcript entry ${entry.id} collides with ${other} on ${clashes.join(", ")}`)
    }
    seen.id.set(entry.id, entry.id)
    seen.order.set(entry.order, entry.id)
    seen.kind.set(entry.kind, entry.id)
  }
  return [...entries].sort((a, b) => a.order - b.order)
}

/**
 * The entry for an item, or `undefined` when nothing claims it.
 *
 * `undefined` is not a failure to handle quietly. The chrome renders the raw
 * payload labelled `unrendered`, because a transcript that drops what it does
 * not recognise is the same defect class the board exists to remove: an empty,
 * reassuring surface where something actually happened.
 */
export function resolveEntry(
  entries: readonly AnyTranscriptEntry[],
  item: TranscriptItem,
): AnyTranscriptEntry | undefined {
  return entries.find((entry) => entry.kind === item.kind)
}
