import type { TuiPluginApi } from "@ranex/plugin/tui"
import { For } from "solid-js"
import { detectGlyphs } from "../../../theme/glyphs"
import type { BoardPaneProps } from "../pane"

const glyphs = detectGlyphs()

export type WorkflowStepState = "approved" | "derived" | "frozen" | "incomplete" | "divergent" | "refused" | "unmapped"

type WorkflowStepFields = {
  readonly id: string
  readonly label: string
  readonly digest: string
}

type MappedWorkflowStep = WorkflowStepFields &
  (
    | {
        readonly kind: "path"
        readonly state: Exclude<WorkflowStepState, "unmapped">
        readonly derivedFrom: { readonly kind: "graph"; readonly digest: string }
      }
    | {
        readonly kind: "scenario"
        readonly state: Exclude<WorkflowStepState, "unmapped">
        readonly derivedFrom: { readonly kind: "path"; readonly digest: string }
      }
    | {
        readonly kind: "contract-tests"
        readonly state: Exclude<WorkflowStepState, "unmapped">
        readonly derivedFrom: { readonly kind: "scenario"; readonly digest: string }
      }
    | {
        readonly kind: "gate"
        readonly state: Exclude<WorkflowStepState, "unmapped">
        readonly derivedFrom: { readonly kind: "scenario"; readonly digest: string }
      }
  )

export type WorkflowStep =
  | (WorkflowStepFields & {
      readonly kind: "graph"
      readonly state: Exclude<WorkflowStepState, "derived" | "frozen" | "unmapped">
      readonly derivedFrom: null
    })
  | MappedWorkflowStep
  | (WorkflowStepFields & {
      readonly kind: "gate"
      readonly state: "unmapped"
      readonly derivedFrom: null
    })

export type WorkflowChain =
  | {
      readonly started: false
      readonly testsFrozen: false
      readonly divergent: false
      readonly graph: null
      readonly paths: readonly []
      readonly scenarios: readonly []
      readonly contractTests: readonly []
      readonly gates: readonly []
    }
  | {
      readonly started: true
      readonly testsFrozen: boolean
      readonly divergent: boolean
      readonly graph: Extract<WorkflowStep, { readonly kind: "graph" }>
      readonly paths: readonly Extract<WorkflowStep, { readonly kind: "path" }>[]
      readonly scenarios: readonly Extract<WorkflowStep, { readonly kind: "scenario" }>[]
      readonly contractTests: readonly Extract<WorkflowStep, { readonly kind: "contract-tests" }>[]
      readonly gates: readonly Extract<WorkflowStep, { readonly kind: "gate" }>[]
    }

export function WorkflowChainDetails(props: { readonly api: TuiPluginApi; readonly chain: WorkflowChain }) {
  const theme = () => props.api.theme.current

  if (!props.chain.started) {
    return (
      <box gap={1}>
        <text fg={theme().warning}>{glyphs.warn} CHAIN NOT STARTED — no intake has happened.</text>
        <text fg={theme().textMuted}>No empty chain is shown as complete.</text>
        <ReadOnly api={props.api} />
      </box>
    )
  }

  return (
    <box gap={1}>
      {props.chain.divergent ? (
        <text fg={theme().error}>
          {glyphs.no} DIVERGENT — the graph changed after tests were frozen; the frozen suite does not match.
        </text>
      ) : null}
      {!props.chain.testsFrozen ? (
        <text fg={theme().warning}>{glyphs.warn} INCOMPLETE — contract tests are not frozen; this chain is not ready.</text>
      ) : null}
      <text fg={theme().textMuted}>APPROVED GRAPH — ROOT OF TRUST</text>
      <WorkflowStepRow api={props.api} step={props.chain.graph} />
      <text fg={theme().textMuted}>PATHS — DERIVED FROM GRAPH</text>
      <For each={props.chain.paths}>{(step) => <WorkflowStepRow api={props.api} step={step} />}</For>
      <text fg={theme().textMuted}>SCENARIOS — DERIVED FROM PATHS</text>
      <For each={props.chain.scenarios}>{(step) => <WorkflowStepRow api={props.api} step={step} />}</For>
      <text fg={theme().textMuted}>CONTRACT TESTS — DERIVED FROM SCENARIOS</text>
      <For each={props.chain.contractTests}>{(step) => <WorkflowStepRow api={props.api} step={step} />}</For>
      <text fg={theme().textMuted}>GATES — MAPPED TO PRODUCING SCENARIOS</text>
      <For each={props.chain.gates}>{(step) => <WorkflowStepRow api={props.api} step={step} />}</For>
      <ReadOnly api={props.api} />
    </box>
  )
}

function Workflow(props: BoardPaneProps) {
  if (props.data.state === "unread") {
    return (
      <box gap={1}>
        <text fg={props.api.theme.current.warning}>{glyphs.warn} CHAIN NOT STARTED — no intake has happened.</text>
        <text fg={props.api.theme.current.textMuted}>No workflow data was read: {props.data.why}.</text>
        <text fg={props.api.theme.current.textMuted}>Tracked as BOARD-01; the return channel is ADR-019.</text>
        <ReadOnly api={props.api} />
      </box>
    )
  }

  return (
    <box gap={1}>
      <text fg={props.api.theme.current.warning}>{glyphs.warn} Workflow chain unavailable.</text>
      <text fg={props.api.theme.current.text}>No workflow chain was read for this subject.</text>
      <text fg={props.api.theme.current.textMuted}>subject {props.data.record.subject_digest}</text>
      <For each={["approved graph", "paths", "scenarios", "contract tests", "gates"]}>
        {(step) => <text fg={props.api.theme.current.textMuted}>{step} — state unavailable; digest unavailable</text>}
      </For>
      <text fg={props.api.theme.current.warning}>INCOMPLETE — test freeze status unavailable; this chain is not ready.</text>
      <text fg={props.api.theme.current.textMuted}>derivation and unmapped-gate checks unavailable</text>
      <ReadOnly api={props.api} />
    </box>
  )
}

function WorkflowStepRow(props: { readonly api: TuiPluginApi; readonly step: WorkflowStep }) {
  const theme = () => props.api.theme.current
  return (
    <box>
      <box flexDirection="row" gap={1}>
        <StepState api={props.api} state={props.step.state} />
        <text fg={theme().text}>{props.step.label}</text>
        <text fg={theme().textMuted}>digest {props.step.digest}</text>
      </box>
      <text fg={props.step.derivedFrom === null ? theme().textMuted : theme().text}>
        {props.step.derivedFrom === null
          ? props.step.state === "unmapped"
            ? "UNMAPPED — no parent scenario; this gate is not traceable to the approved graph"
            : "root — approved graph"
          : `derived from ${props.step.derivedFrom.kind} ${props.step.derivedFrom.digest}`}
      </text>
    </box>
  )
}

function StepState(props: { readonly api: TuiPluginApi; readonly state: WorkflowStepState }) {
  switch (props.state) {
    case "approved":
      return <text fg={props.api.theme.current.success}>{glyphs.ok} APPROVED</text>
    case "derived":
      return <text fg={props.api.theme.current.primary}>{glyphs.arrow} DERIVED</text>
    case "frozen":
      return <text fg={props.api.theme.current.success}>{glyphs.ok} FROZEN — READ-ONLY TO IMPLEMENTERS</text>
    case "incomplete":
      return <text fg={props.api.theme.current.warning}>{glyphs.warn} INCOMPLETE</text>
    case "divergent":
      return <text fg={props.api.theme.current.error}>{glyphs.no} DIVERGENT — FROZEN SUITE DOES NOT MATCH</text>
    case "refused":
      return <text fg={props.api.theme.current.error}>{glyphs.no} REFUSED — change and re-approve the graph</text>
    case "unmapped":
      return <text fg={props.api.theme.current.error}>{glyphs.flag} UNMAPPED</text>
  }
  const exhaustive: never = props.state
  return exhaustive
}

function ReadOnly(props: { readonly api: TuiPluginApi }) {
  return (
    <text fg={props.api.theme.current.textMuted}>
      READ ONLY — this pane approves, edits, and re-derives nothing; derived changes require graph re-approval.
    </text>
  )
}

export const WorkflowPane = {
  id: "ranex.board.workflow",
  title: "Workflow",
  order: 800,
  render: (props) => <Workflow {...props} />,
} satisfies import("../pane").BoardPane
