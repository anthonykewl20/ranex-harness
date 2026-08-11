import type { TuiPluginApi } from "@ranex/plugin/tui"
import type { JSXElement } from "solid-js"
import { detectGlyphs } from "../../theme/glyphs"

/**
 * The contract every board pane implements. BOARD-05..BOARD-14.
 *
 * This exists so panes can be built in parallel without fighting over one file:
 * a pane is one module plus one line in `panes/index.ts`, and it never edits the
 * board shell, another pane, or anything upstream owns.
 *
 * The fields this reads are declared structurally rather than imported from
 * `@ranex/schema`, for the reason `index.tsx` records: the SDK is the TUI's
 * boundary, and `packages/schema/src/verdict.ts` stays the authority on the full
 * shape. When BOARD-01's read channel lands, the type arrives with the data path
 * and this declaration goes away.
 */
export type VerdictRecord = {
  verdict: "PASS" | "FAIL"
  subject_digest: string
}

/**
 * What a pane is given, and why it is a union rather than `VerdictRecord | undefined`.
 *
 * A pane must be unable to render as though a verdict existed when none was
 * read. Optionality does not enforce that — every consumer would be free to
 * `?.` its way past the question, and the one that forgets renders an empty,
 * reassuring surface. That is the exact failure this project exists to remove,
 * and it is the failure found in five of the mature verification systems read
 * for ADR-019: absence and invalidity collapse into one state somewhere in the
 * stack, usually where a count is compared rather than a case matched.
 *
 * So the state is a tag the pane has to open, and `unread` carries the reason it
 * could not be read. There is deliberately no third arm for "empty": a verdict
 * that proves nothing is a `read` verdict whose causes say so.
 */
export type BoardData =
  | { readonly state: "unread"; readonly why: string }
  | { readonly state: "read"; readonly record: VerdictRecord }

export type BoardPaneProps = {
  readonly api: TuiPluginApi
  readonly data: BoardData
}

export type BoardPane = {
  /** Stable, namespaced, and unique across the registry. */
  readonly id: string
  /** Shown in the pane frame. */
  readonly title: string
  /**
   * Sort key. Panes render in ascending order, so the registry's array order is
   * not load-bearing and two panes added concurrently cannot reorder each other.
   * Spaced by 100 to leave room between.
   */
  readonly order: number
  readonly render: (props: BoardPaneProps) => JSXElement
}

const glyphs = detectGlyphs()

/**
 * The shared chrome, so panes look like one surface rather than seven.
 *
 * Title styling lives here and nowhere else. A pane that wants a different frame
 * is telling you the frame is wrong; change it here for all of them.
 */
export function PaneFrame(props: { api: TuiPluginApi; title: string; children: JSXElement }) {
  const theme = () => props.api.theme.current

  return (
    <box gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={theme().textMuted}>{glyphs.right}</text>
        <text fg={theme().text}>
          <b>{props.title}</b>
        </text>
      </box>
      {props.children}
    </box>
  )
}
