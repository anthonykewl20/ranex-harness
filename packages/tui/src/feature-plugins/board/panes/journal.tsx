import type { TuiPluginApi } from "@ranex/plugin/tui"
import { For, Show, createMemo } from "solid-js"
import { detectGlyphs } from "../../../theme/glyphs"
import type { BoardPaneProps } from "../pane"

const glyphs = detectGlyphs()

/** Five rows leave room for chain state, filter, pager, digest, and refusal text in 24 lines. */
export const JOURNAL_PAGE_SIZE = 5
export const JOURNAL_DIGEST_LENGTH = 18

export type JournalEntry = {
  readonly sequence: number
  readonly kind: string
  readonly digest: string
  readonly previousDigest: string | null
  readonly subjectDigest: string
}

export type JournalVerification =
  | { readonly state: "unverified" }
  | { readonly state: "verifying"; readonly checked: number; readonly total?: number }
  | { readonly state: "verified"; readonly entryCount: number }
  | { readonly state: "broken"; readonly sequence: number }

/**
 * Availability and verification are separate facts. An unreadable journal has
 * no rows or chain result for this pane to reach, while an available journal can
 * still be unverified.
 */
export type JournalData =
  | {
      readonly state: "unavailable"
      readonly reason: "unreadable" | "locked"
      readonly detail: string
    }
  | {
      readonly state: "read"
      readonly subjectDigest: string
      readonly evaluationDigest: string
      readonly entries: readonly JournalEntry[]
      readonly verification: JournalVerification
    }

export function paginateJournalEntries(
  entries: readonly JournalEntry[],
  subjectDigest: string,
  requestedPage: number,
) {
  const matching = entries.filter((entry) => entry.subjectDigest === subjectDigest)
  const pageCount = Math.max(1, Math.ceil(matching.length / JOURNAL_PAGE_SIZE))
  const page = Math.max(0, Math.min(Math.floor(requestedPage), pageCount - 1))
  return {
    page,
    pageCount,
    rows: matching.slice(page * JOURNAL_PAGE_SIZE, (page + 1) * JOURNAL_PAGE_SIZE),
    total: matching.length,
    filtered: entries.length - matching.length,
  }
}

export function formatJournalDigest(digest: string | null) {
  if (digest === null) return "GENESIS"
  if (digest.length <= JOURNAL_DIGEST_LENGTH) return digest
  return `${digest.slice(0, JOURNAL_DIGEST_LENGTH - 1)}…`
}

export function JournalTable(props: {
  readonly api: TuiPluginApi
  readonly data: JournalData
  readonly page: number
  readonly onPageChange?: (page: number) => void
}) {
  const data = props.data
  if (data.state === "unavailable") {
    return (
      <box gap={1}>
        <box>
          <text fg={props.api.theme.current.error}>
            <b>{glyphs.flag} JOURNAL OPERATIONAL REFUSAL</b>
          </text>
          <text fg={props.api.theme.current.error}>
            journal {data.reason} — {data.detail}
          </text>
        </box>
        <text fg={props.api.theme.current.text}>No chain status or journal entries can be shown.</text>
        <ReadOnlyNotice api={props.api} />
      </box>
    )
  }

  const theme = () => props.api.theme.current
  const current = createMemo(() => paginateJournalEntries(data.entries, data.subjectDigest, props.page))

  return (
    <box gap={1}>
      <VerificationStatus api={props.api} verification={data.verification} />

      <text fg={theme().textMuted}>
        FILTER: subject {data.subjectDigest} {glyphs.dot} {current().total} shown {glyphs.dot}{" "}
        {current().filtered} other-subject {current().filtered === 1 ? "entry" : "entries"} hidden
      </text>

      <box>
        <box flexDirection="row">
          <text width={10} fg={theme().textMuted}>
            SEQUENCE
          </text>
          <text width={26} fg={theme().textMuted}>
            KIND
          </text>
          <text width={22} fg={theme().textMuted}>
            DIGEST
          </text>
          <text flexGrow={1} fg={theme().textMuted}>
            PREVIOUS DIGEST
          </text>
        </box>

        <Show when={current().total > JOURNAL_PAGE_SIZE}>
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
                if (current().page + 1 < current().pageCount) {
                  props.onPageChange?.(current().page + 1)
                }
              }}
            >
              next {glyphs.arrow}
            </text>
          </box>
        </Show>

        <Show
          when={current().rows.length}
          fallback={<text fg={theme().text}>No journal entries were read for this subject.</text>}
        >
          <For each={current().rows}>
            {(entry) => (
              <box flexDirection="row">
                <text width={10} fg={theme().text}>
                  {entry.sequence}
                </text>
                <text width={26} fg={theme().primary}>
                  {entry.kind}
                </text>
                <text width={22} fg={theme().text}>
                  {formatJournalDigest(entry.digest)}
                </text>
                <text flexGrow={1} fg={theme().textMuted}>
                  {formatJournalDigest(entry.previousDigest)}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>

      <box flexDirection="row" gap={1}>
        <text fg={theme().textMuted}>evaluation record digest</text>
        <text fg={theme().text}>{data.evaluationDigest}</text>
      </box>

      <ReadOnlyNotice api={props.api} />
    </box>
  )
}

function Journal(props: BoardPaneProps) {
  const subject =
    props.data.state === "read"
      ? `subject ${props.data.record.subject_digest}`
      : "unavailable — no current subject was read"
  const explanation =
    props.data.state === "unread"
      ? props.data.why
      : "board data does not provide journal records or the evaluation record digest"

  return (
    <box gap={1}>
      <VerificationStatus api={props.api} verification={{ state: "unverified" }} />
      <text fg={props.api.theme.current.textMuted}>FILTER: {subject}</text>
      <text fg={props.api.theme.current.text}>No journal entries were read.</text>
      <text fg={props.api.theme.current.textMuted}>{explanation}</text>
      <text fg={props.api.theme.current.textMuted}>evaluation record digest unavailable</text>
      <ReadOnlyNotice api={props.api} />
    </box>
  )
}

function VerificationStatus(props: {
  readonly api: TuiPluginApi
  readonly verification: JournalVerification
}) {
  const theme = () => props.api.theme.current

  switch (props.verification.state) {
    case "unverified":
      return (
        <box>
          <text fg={theme().warning}>
            <b>{glyphs.warn} STATUS: UNVERIFIED</b>
          </text>
          <text fg={theme().text}>ranex journal verify has not run. Absence blocks.</text>
        </box>
      )
    case "verifying":
      return (
        <box>
          <text fg={theme().warning}>
            <b>{glyphs.arrow} STATUS: VERIFYING</b>
          </text>
          <text fg={theme().text}>
            ranex journal verify is still running: {props.verification.checked}
            {props.verification.total === undefined ? " entries checked" : ` of ${props.verification.total} entries checked`}.
          </text>
        </box>
      )
    case "verified":
      return (
        <box>
          <text fg={theme().success}>
            <b>{glyphs.ok} STATUS: VERIFIED</b>
          </text>
          <text fg={theme().text}>
            ranex journal verify confirmed {props.verification.entryCount}{" "}
            {props.verification.entryCount === 1 ? "entry" : "entries"}.
          </text>
        </box>
      )
    case "broken":
      return (
        <box>
          <text fg={theme().error}>
            <b>{glyphs.no} STATUS: CHAIN BROKEN</b>
          </text>
          <text fg={theme().error}>
            <b>Break at sequence {props.verification.sequence}. DO NOT TRUST later entries.</b>
          </text>
        </box>
      )
  }
  const exhaustive: never = props.verification
  return exhaustive
}

function ReadOnlyNotice(props: { readonly api: TuiPluginApi }) {
  return (
    <text fg={props.api.theme.current.textMuted}>
      READ ONLY — journal records and verification state are displayed; nothing is changed.
    </text>
  )
}

export const JournalPane = {
  id: "ranex.board.journal",
  title: "Journal",
  order: 600,
  render: (props) => <Journal {...props} />,
} satisfies import("../pane").BoardPane
