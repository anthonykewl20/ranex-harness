import type { TuiPluginApi } from "@ranex/plugin/tui"
import { For } from "solid-js"
import { detectGlyphs } from "../../../theme/glyphs"
import type { BoardPaneProps } from "../pane"

const glyphs = detectGlyphs()

export type EscalationStatus = "running" | "stopped-awaiting-owner" | "failed"

export type Attempt = {
  readonly index: number
  readonly scopeDelta: string | null
}

export type EscalationQuestion = string

type EscalationFields = {
  readonly attempts: readonly Attempt[]
  readonly inFlightRun: string | null
}

export type EscalationRecord =
  | (EscalationFields & {
      readonly status: "running"
      readonly question: null
    })
  | (EscalationFields & {
      readonly status: "stopped-awaiting-owner"
      readonly question: EscalationQuestion
    })
  | (EscalationFields & {
      readonly status: "failed"
      readonly question: null
    })

export function EscalationDetails(props: { readonly api: TuiPluginApi; readonly escalation: EscalationRecord }) {
  const theme = () => props.api.theme.current
  const attemptCount = () => new Set(props.escalation.attempts.map((attempt) => attempt.index)).size

  return (
    <box gap={1}>
      <Status api={props.api} status={props.escalation.status} />
      <text fg={theme().text}>attempt count {attemptCount()}</text>
      <For each={props.escalation.attempts}>
        {(attempt, position) => {
          const retriesBefore = () =>
            props.escalation.attempts
              .slice(0, position())
              .filter((candidate) => candidate.index === attempt.index).length
          return (
            <text fg={attempt.scopeDelta === null ? theme().textMuted : theme().warning}>
              attempt {attempt.index}
              {retriesBefore() > 0 ? ` retry ${retriesBefore()}` : ""} — {attempt.scopeDelta === null
                ? "same scope and tests"
                : `NEW SCOPE — ${attempt.scopeDelta}; new approval required`}
            </text>
          )
        }}
      </For>
      <OwnerQuestion api={props.api} escalation={props.escalation} />
      <box>
        <text fg={theme().textMuted}>IN-FLIGHT RUN — shown separately from escalation state</text>
        <text fg={props.escalation.inFlightRun === null ? theme().textMuted : theme().warning}>
          {props.escalation.inFlightRun === null
            ? "none recorded"
            : `${props.escalation.inFlightRun} remains in flight; STOPPED does not mean CANCELLED`}
        </text>
      </box>
      <text fg={theme().textMuted}>DISPLAY ONLY — this pane decides no threshold and enforces no attempt budget.</text>
    </box>
  )
}

function Escalation(props: BoardPaneProps) {
  if (props.data.state === "unread") {
    return (
      <box gap={1}>
        <text fg={props.api.theme.current.warning}>{glyphs.warn} Escalation policy UNDECIDED.</text>
        <text fg={props.api.theme.current.text}>attempt count unavailable</text>
        <text fg={props.api.theme.current.text}>No escalation policy exists yet. Threshold: UNDECIDED.</text>
        <text fg={props.api.theme.current.textMuted}>No escalation data was read: {props.data.why}.</text>
        <text fg={props.api.theme.current.textMuted}>Tracked as BOARD-01; the return channel is ADR-019.</text>
        <text fg={props.api.theme.current.textMuted}>
          DISPLAY ONLY — this pane decides no threshold and enforces no attempt budget.
        </text>
      </box>
    )
  }

  return (
    <box gap={1}>
      <text fg={props.api.theme.current.warning}>{glyphs.warn} Escalation data unavailable.</text>
      <text fg={props.api.theme.current.text}>No escalation data was read for this subject.</text>
      <text fg={props.api.theme.current.textMuted}>subject {props.data.record.subject_digest}</text>
      <text fg={props.api.theme.current.textMuted}>attempts unavailable — expected index and scope delta rows</text>
      <text fg={props.api.theme.current.textMuted}>
        status unavailable — expected running, stopped awaiting owner, or failed
      </text>
      <text fg={props.api.theme.current.textMuted}>owner question unavailable — expected kernel-recorded words</text>
      <text fg={props.api.theme.current.textMuted}>in-flight run unavailable — reported separately from stop state</text>
      <text fg={props.api.theme.current.textMuted}>
        DISPLAY ONLY — this pane decides no threshold and enforces no attempt budget.
      </text>
    </box>
  )
}

function Status(props: { readonly api: TuiPluginApi; readonly status: EscalationStatus }) {
  switch (props.status) {
    case "running":
      return <text fg={props.api.theme.current.primary}>{glyphs.arrow} STATUS: RUNNING</text>
    case "stopped-awaiting-owner":
      return (
        <text fg={props.api.theme.current.warning}>
          {glyphs.flag} STATUS: STOPPED, AWAITING THE OWNER
        </text>
      )
    case "failed":
      return <text fg={props.api.theme.current.error}>{glyphs.no} STATUS: FAILED</text>
  }
  const exhaustive: never = props.status
  return exhaustive
}

function OwnerQuestion(props: { readonly api: TuiPluginApi; readonly escalation: EscalationRecord }) {
  switch (props.escalation.status) {
    case "running":
      return <text fg={props.api.theme.current.textMuted}>owner question — none recorded while running</text>
    case "stopped-awaiting-owner":
      return (
        <box>
          <text fg={props.api.theme.current.textMuted}>QUESTION RECORDED FOR OWNER</text>
          <text fg={props.api.theme.current.text}>{props.escalation.question}</text>
        </box>
      )
    case "failed":
      return <text fg={props.api.theme.current.textMuted}>owner question — none recorded for failed state</text>
  }
  const exhaustive: never = props.escalation
  return exhaustive
}

export const EscalationPane = {
  id: "ranex.board.escalation",
  title: "Escalation",
  order: 700,
  render: (props) => <Escalation {...props} />,
} satisfies import("../pane").BoardPane
