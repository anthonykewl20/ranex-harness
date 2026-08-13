import type { TuiPluginApi } from "@ranex/plugin/tui"
import { For, Show, createMemo } from "solid-js"
import { detectGlyphs } from "../../../theme/glyphs"
import type { BoardPaneProps } from "../pane"
import { causePresentation, classifyCause } from "../verdict-cause"

const glyphs = detectGlyphs()

/**
 * Three worst-case admitted rows leave room for status, an above-row pager,
 * two-line suite summaries, and visible truncation inside a 24-line terminal.
 * GATE_PAGE_SIZE can be larger because each gate is one line; evidence rows are
 * deliberately multi-line so none of their identity fields disappear.
 */
export const EVIDENCE_PAGE_SIZE = 3
export const EVIDENCE_SUITE_OUTPUT_MAX_CHARACTERS = 96
export const EVIDENCE_SUITE_OUTPUT_MAX_LINES = 2

export type EvidenceRecord = {
  readonly claim_id: string
  readonly subject_digest: string
  readonly command_digest: string
  readonly producer: string
  readonly suite_results_summary: string
  readonly record_path: string
}

export type EvidenceRejection = {
  readonly index: number
  readonly reason: string
  readonly detail: string
  readonly claim_id: string | null
}

export type EvidenceCause = {
  readonly claim_id: string | null
  readonly cause: string
  readonly detail?: string
}

export type EvidenceData = {
  readonly verdict: "PASS" | "FAIL"
  readonly subject_digest: string
  readonly records: readonly EvidenceRecord[]
  readonly rejections: readonly EvidenceRejection[]
  readonly causes: readonly EvidenceCause[]
}

type EvidenceRow =
  | { readonly state: "cause"; readonly cause: EvidenceCause }
  | { readonly state: "absence-withheld" }
  | { readonly state: "admitted"; readonly index: number; readonly record: EvidenceRecord }
  | { readonly state: "refused"; readonly rejection: EvidenceRejection }

export function truncateEvidenceSuiteOutput(output: string) {
  const lines = output.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  const lineBounded = lines.slice(0, EVIDENCE_SUITE_OUTPUT_MAX_LINES).join("\n")
  const characters = Array.from(lineBounded)
  const text = characters.slice(0, EVIDENCE_SUITE_OUTPUT_MAX_CHARACTERS).join("")
  return {
    text,
    shownCharacters: Array.from(text).length,
    totalCharacters: Array.from(output).length,
    shownLines: text === "" ? 0 : text.split("\n").length,
    totalLines: output === "" ? 0 : lines.length,
    truncated:
      lines.length > EVIDENCE_SUITE_OUTPUT_MAX_LINES || characters.length > EVIDENCE_SUITE_OUTPUT_MAX_CHARACTERS,
  }
}

export function paginateEvidenceRows(data: EvidenceData, requestedPage: number) {
  const unattributable = data.rejections.some((rejection) => usableClaimID(rejection.claim_id) === null)
  const rows: readonly EvidenceRow[] = [
    ...data.causes
      .filter((cause) => !(unattributable && cause.cause === "absent"))
      .map((cause) => ({ state: "cause" as const, cause })),
    ...(unattributable ? [{ state: "absence-withheld" as const }] : []),
    ...data.records.map((record, index) => ({ state: "admitted" as const, index, record })),
    ...data.rejections.map((rejection) => ({ state: "refused" as const, rejection })),
  ]
  const pageCount = Math.max(1, Math.ceil(rows.length / EVIDENCE_PAGE_SIZE))
  const page = Math.max(0, Math.min(Math.floor(requestedPage), pageCount - 1))
  return {
    page,
    pageCount,
    rows: rows.slice(page * EVIDENCE_PAGE_SIZE, (page + 1) * EVIDENCE_PAGE_SIZE),
  }
}

export function EvidenceTable(props: {
  readonly api: TuiPluginApi
  readonly data: EvidenceData
  readonly page: number
  readonly onPageChange?: (page: number) => void
}) {
  const theme = () => props.api.theme.current
  const current = createMemo(() => paginateEvidenceRows(props.data, props.page))
  const status = () => {
    if (props.data.records.length) {
      return `EVIDENCE PRESENT — ${props.data.records.length} admitted; ${props.data.rejections.length} refused`
    }
    if (props.data.rejections.length) {
      return `EVIDENCE REFUSED — 0 admitted; ${props.data.rejections.length} refused before kernel admission`
    }
    return "NO EVIDENCE — no admitted or refused records were read"
  }

  return (
    <box>
      <text fg={props.data.verdict === "PASS" ? theme().success : theme().error}>
        VERDICT {props.data.verdict} {glyphs.dot} subject digest {props.data.subject_digest} {glyphs.dot} refusals
        always shown
      </text>
      <text
        fg={props.data.records.length ? theme().text : props.data.rejections.length ? theme().error : theme().warning}
      >
        {status()}
      </text>

      <Show when={current().pageCount > 1}>
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

      <For each={current().rows}>
        {(row) => {
          if (row.state === "cause") {
            const presentation = causePresentation(classifyCause(row.cause.cause), theme(), glyphs)
            return (
              <text fg={presentation.color}>
                CAUSE claim {usableClaimID(row.cause.claim_id) ?? "NO CLAIM"} {glyphs.dot} {presentation.glyph}{" "}
                {presentation.word} — {presentation.explanation}
                {row.cause.detail === undefined ? "" : `; ${row.cause.detail}`}
              </text>
            )
          }

          if (row.state === "absence-withheld") {
            return (
              <text fg={theme().error}>
                {glyphs.flag} ABSENCE WITHHELD — a refused record has NO CLAIM; remaining claims are not labelled absent
              </text>
            )
          }

          if (row.state === "refused") {
            const claimID = usableClaimID(row.rejection.claim_id)
            const presentation = causePresentation(
              classifyCause(claimID === null ? "unattributable" : "refused"),
              theme(),
              glyphs,
            )
            return (
              <box>
                <text fg={presentation.color}>
                  {presentation.glyph} REFUSED #{row.rejection.index} {glyphs.dot} {row.rejection.reason} {glyphs.dot}{" "}
                  {claimID === null ? "NO CLAIM" : `claim ${claimID}`} {glyphs.dot} {presentation.word} —{" "}
                  {presentation.explanation}
                </text>
                <text fg={theme().textMuted}>detail {row.rejection.detail}</text>
              </box>
            )
          }

          return <AdmittedRecord api={props.api} index={row.index} record={row.record} />
        }}
      </For>
    </box>
  )
}

function AdmittedRecord(props: {
  readonly api: TuiPluginApi
  readonly index: number
  readonly record: EvidenceRecord
}) {
  const output = () => truncateEvidenceSuiteOutput(props.record.suite_results_summary)
  return (
    <box>
      <text fg={props.api.theme.current.success}>
        {glyphs.ok} ADMITTED #{props.index} {glyphs.dot} claim {props.record.claim_id} {glyphs.dot} producer{" "}
        {props.record.producer}
      </text>
      <text fg={props.api.theme.current.textMuted}>subject digest {props.record.subject_digest}</text>
      <text fg={props.api.theme.current.textMuted}>command digest {props.record.command_digest}</text>
      <text fg={props.api.theme.current.text}>suite results {output().text || "no suite results recorded"}</text>
      <Show when={output().truncated}>
        <text fg={props.api.theme.current.warning}>
          {glyphs.warn} SUITE OUTPUT TRUNCATED — showing {output().shownCharacters} of {output().totalCharacters}{" "}
          characters, {output().shownLines} of {output().totalLines} lines; full record {props.record.record_path}
        </text>
      </Show>
    </box>
  )
}

function usableClaimID(claimID: string | null) {
  if (claimID === null || claimID.trim() === "") return null
  return claimID
}

function Evidence(props: BoardPaneProps) {
  if (props.data.state === "unread") {
    return (
      <box gap={1}>
        <text fg={props.api.theme.current.warning}>{glyphs.warn} Evidence unavailable.</text>
        <text fg={props.api.theme.current.text}>No evidence or admission records were read.</text>
        <text fg={props.api.theme.current.textMuted}>{props.data.why}</text>
      </box>
    )
  }

  return (
    <box gap={1}>
      <text fg={props.api.theme.current.warning}>{glyphs.warn} Evidence records unavailable.</text>
      <text fg={props.api.theme.current.text}>
        A verdict was read, but no admitted records or admission rejections were provided.
      </text>
      <text fg={props.api.theme.current.textMuted}>subject {props.data.record.subject_digest}</text>
    </box>
  )
}

export const EvidencePane = {
  id: "ranex.board.evidence",
  title: "Evidence",
  order: 200,
  render: (props) => <Evidence {...props} />,
} satisfies import("../pane").BoardPane
