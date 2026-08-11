import type { TuiPluginApi } from "@ranex/plugin/tui"
import { For, Show, createMemo } from "solid-js"
import { detectGlyphs, type GlyphSet } from "../../../theme/glyphs"
import type { BoardPaneProps } from "../pane"

const glyphs = detectGlyphs()

/**
 * Rows per page.
 *
 * Ten, not twenty. A page must fit the space the pane actually gets, or the last
 * rows fall off the bottom and the operator is never told — silent truncation,
 * which is the one kind this project does not permit. Twenty rows plus a header,
 * a pager and the gaps between rows needs well over thirty lines; the board
 * shares an ordinary terminal with other panes.
 *
 * This is still a guess about the viewport rather than a measurement of it. The
 * honest fix is for the pane to size its own page from the height it is given,
 * and that needs layout information this component is not handed today. Named
 * and exported so a caller that does know can override it.
 */
export const GATE_PAGE_SIZE = 10

const KNOWN_CAUSES = [
  "contradicted",
  "failed",
  "mismatched",
  "stale",
  "absent",
  "refused",
  "unattributable",
] as const
type KnownCause = (typeof KNOWN_CAUSES)[number]
const KNOWN_CAUSE_SET = new Set<string>(KNOWN_CAUSES)

export type GateRow = {
  readonly gate: string
  readonly evidence: string
  readonly verdict: "PASS" | "FAIL"
  readonly causes: readonly string[]
}

type Theme = TuiPluginApi["theme"]["current"]
type CausePresentation = {
  readonly word: string
  readonly explanation: string
  readonly glyph: string
  readonly color: Theme["error"]
}

export function paginateGateRows(rows: readonly GateRow[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / GATE_PAGE_SIZE))
  const page = Math.max(0, Math.min(Math.floor(requestedPage), pageCount - 1))
  return {
    page,
    pageCount,
    rows: rows.slice(page * GATE_PAGE_SIZE, (page + 1) * GATE_PAGE_SIZE),
  }
}

export function GateTable(props: {
  readonly api: TuiPluginApi
  readonly rows: readonly GateRow[]
  readonly page: number
  readonly onPageChange?: (page: number) => void
}) {
  const theme = () => props.api.theme.current
  const colors = () => ({ pass: theme().success, fail: theme().error })
  const current = createMemo(() => paginateGateRows(props.rows, props.page))

  return (
    <box gap={1}>
      <box flexDirection="row">
        <text width={22} fg={theme().textMuted}>
          GATE
        </text>
        <text width={28} fg={theme().textMuted}>
          EVIDENCE SUMMARY
        </text>
        <text width={12} fg={theme().textMuted}>
          VERDICT
        </text>
        <text flexGrow={1} fg={theme().textMuted}>
          CAUSE
        </text>
      </box>

      {/*
        Above the rows, not below them. A full page is 20 rows plus a header, so
        a footer sits past the bottom of an ordinary terminal and the control
        that moves between pages is the one thing you cannot reach. Same defect
        as the route this board once had, which you could enter and not leave.
      */}
      <Show when={props.rows.length > GATE_PAGE_SIZE}>
        <box flexDirection="row" gap={2}>
          <text
            fg={current().page > 0 ? theme().primary : theme().textMuted}
            onMouseUp={() => {
              if (current().page > 0) props.onPageChange?.(current().page - 1)
            }}
          >
            {glyphs.arrow} previous
          </text>
          <text fg={theme().textMuted}>
            page {current().page + 1} of {current().pageCount}
          </text>
          <text
            fg={current().page + 1 < current().pageCount ? theme().primary : theme().textMuted}
            onMouseUp={() => {
              if (current().page + 1 < current().pageCount) props.onPageChange?.(current().page + 1)
            }}
          >
            next {glyphs.arrow}
          </text>
        </box>
      </Show>

      <For each={current().rows}>
        {(row) => (
            <box flexDirection="row">
              <text width={22} fg={theme().text}>
                {row.gate}
              </text>
              <text width={28} fg={theme().textMuted}>
                {row.evidence}
              </text>
              <text width={12} fg={row.verdict === "PASS" ? colors().pass : colors().fail}>
                {row.verdict === "PASS" ? glyphs.ok : glyphs.no} {row.verdict}
              </text>
              <box flexGrow={1}>
                {/*
                  Three different facts, three different renderings. A PASS has
                  nothing to explain. A FAIL with no cause recorded is missing
                  data, and saying so is not the same as saying the cause was
                  unrecognisable — an earlier version substituted an empty string
                  here, which rendered as "unclassified" and reported absent data
                  under the wording reserved for an unknown kernel cause.
                */}
                <Show
                  when={row.causes.length}
                  fallback={
                    <text fg={row.verdict === "PASS" ? theme().textMuted : theme().warning}>
                      {row.verdict === "PASS" ? "—" : `${glyphs.warn} no cause recorded`}
                    </text>
                  }
                >
                  <For each={row.causes}>
                    {(cause) => {
                      const presentation = causePresentation(cause, theme(), glyphs)
                      return (
                        <text fg={presentation.color}>
                          {presentation.glyph} {presentation.word} — {presentation.explanation}
                        </text>
                      )
                    }}
                  </For>
                </Show>
              </box>
            </box>
        )}
      </For>
    </box>
  )
}

function Gates(props: BoardPaneProps) {
  if (props.data.state === "unread") {
    return (
      <box gap={1}>
        <text fg={props.api.theme.current.warning}>{glyphs.warn} Gates unavailable.</text>
        <text fg={props.api.theme.current.text}>No gate verdicts were read.</text>
        <text fg={props.api.theme.current.textMuted}>{props.data.why}</text>
      </box>
    )
  }

  return (
    <box gap={1}>
      <text fg={props.api.theme.current.warning}>{glyphs.warn} Gate rows unavailable.</text>
      <text fg={props.api.theme.current.text}>A verdict was read, but no gate list was provided.</text>
      <text fg={props.api.theme.current.textMuted}>subject {props.data.record.subject_digest}</text>
    </box>
  )
}

function causePresentation(cause: string, theme: Theme, set: GlyphSet): CausePresentation {
  if (!KNOWN_CAUSE_SET.has(cause)) {
    return {
      word: "unclassified",
      explanation: "unknown cause; blocks",
      glyph: set.flag,
      color: theme.error,
    }
  }
  return knownCausePresentation(cause as KnownCause, theme, set)
}

function knownCausePresentation(cause: KnownCause, theme: Theme, set: GlyphSet): CausePresentation {
  switch (cause) {
    case "contradicted":
      return { word: cause, explanation: "evidence disagrees", glyph: set.no, color: theme.error }
    case "failed":
      return { word: cause, explanation: "bound command failed", glyph: set.no, color: theme.error }
    case "mismatched":
      return { word: cause, explanation: "command does not match", glyph: set.warn, color: theme.warning }
    case "stale":
      return { word: cause, explanation: "evidence names another subject", glyph: set.warn, color: theme.warning }
    case "absent":
      return { word: cause, explanation: "work never done", glyph: set.warn, color: theme.warning }
    case "refused":
      return { word: cause, explanation: "record refused", glyph: set.flag, color: theme.error }
    case "unattributable":
      return { word: cause, explanation: "no usable claim", glyph: set.flag, color: theme.error }
  }
  const exhaustive: never = cause
  return exhaustive
}

export const GatesPane = {
  id: "ranex.board.gates",
  title: "Gates",
  order: 100,
  render: (props) => <Gates {...props} />,
} satisfies import("../pane").BoardPane
