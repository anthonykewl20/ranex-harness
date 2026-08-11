import type { TuiPluginApi } from "@ranex/plugin/tui"
import { Show } from "solid-js"
import { detectGlyphs } from "../../../theme/glyphs"
import type { BoardPaneProps } from "../pane"

const glyphs = detectGlyphs()

export const RUN_OUTPUT_MAX_CHARACTERS = 240
export const RUN_OUTPUT_MAX_LINES = 4

export type RunOutcome =
  | { readonly state: "passed"; readonly exit_code: 0 }
  | { readonly state: "failed"; readonly exit_code: number }
  | { readonly state: "killed"; readonly reason: string; readonly exit_code?: number }

export type RunConfinement =
  | {
      readonly state: "confined"
      readonly filesystem_scope: string
      readonly network_posture: string
      readonly cgroup_limits: string
    }
  | { readonly state: "unconfined"; readonly reason: string }

export type RunRecord = {
  readonly command: string
  readonly command_digest: string
  readonly bound_command_digest: string
  readonly outcome: RunOutcome
  readonly duration_ms: number
  readonly worktree: {
    readonly path: string
    readonly branch: string
    readonly state: "present" | "missing"
  }
  readonly confinement: RunConfinement
  readonly subject_digest: string
  readonly dependencies:
    | { readonly state: "approved"; readonly store: string }
    | { readonly state: "unapproved"; readonly source: string }
  readonly output: string
}

export function truncateRunOutput(output: string) {
  const lines = output.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  const lineBounded = lines.slice(0, RUN_OUTPUT_MAX_LINES).join("\n")
  const characters = Array.from(lineBounded)
  const text = characters.slice(0, RUN_OUTPUT_MAX_CHARACTERS).join("")
  return {
    text,
    shownCharacters: Array.from(text).length,
    totalCharacters: Array.from(output).length,
    shownLines: text === "" ? 0 : text.split("\n").length,
    totalLines: output === "" ? 0 : lines.length,
    truncated: lines.length > RUN_OUTPUT_MAX_LINES || characters.length > RUN_OUTPUT_MAX_CHARACTERS,
  }
}

export function RunDetails(props: { readonly api: TuiPluginApi; readonly run: RunRecord }) {
  const theme = () => props.api.theme.current
  const output = () => truncateRunOutput(props.run.output)
  const digestMatches = () => props.run.command_digest === props.run.bound_command_digest

  return (
    <box>
      <text fg={theme().textMuted}>RUN</text>
      <box flexDirection="row" gap={1}>
        <text fg={theme().textMuted}>status</text>
        <RunStatus api={props.api} outcome={props.run.outcome} />
        <text fg={theme().textMuted}>duration {formatDuration(props.run.duration_ms)}</text>
      </box>
      <Row api={props.api} label="command" value={props.run.command} />
      <Row api={props.api} label="digest" value={props.run.command_digest} />
      <Row api={props.api} label="bound digest" value={props.run.bound_command_digest} />
      <text fg={digestMatches() ? theme().success : theme().error}>
        {digestMatches()
          ? `${glyphs.ok} MATCHED — command digest matches the bound command`
          : `${glyphs.no} MISMATCHED — cause: mismatched; command digest does not match the bound command`}
      </text>
      <Row api={props.api} label="subject" value={props.run.subject_digest} />
      <text fg={props.run.worktree.state === "present" ? theme().text : theme().error}>
        worktree {props.run.worktree.path}
        {props.run.worktree.state === "missing" ? " — MISSING at render time; run is not reproducible from this tree" : ""}
      </text>
      <Row api={props.api} label="branch" value={props.run.worktree.branch} />
      <Confinement api={props.api} confinement={props.run.confinement} />
      <text fg={props.run.dependencies.state === "approved" ? theme().success : theme().error}>
        dependencies {props.run.dependencies.state === "approved" ? "APPROVED STORE" : "UNAPPROVED SOURCE"} —{" "}
        {props.run.dependencies.state === "approved" ? props.run.dependencies.store : props.run.dependencies.source}
      </text>
      <text fg={theme().textMuted}>OUTPUT</text>
      <Show when={output().text} fallback={<text fg={theme().textMuted}>no output recorded</text>}>
        <text fg={theme().text}>{output().text}</text>
      </Show>
      <Show when={output().truncated}>
        <text fg={theme().warning}>
          {glyphs.warn} OUTPUT TRUNCATED — showing {output().shownCharacters} of {output().totalCharacters} characters,{" "}
          {output().shownLines} of {output().totalLines} lines
        </text>
      </Show>
    </box>
  )
}

function RunStatus(props: { readonly api: TuiPluginApi; readonly outcome: RunOutcome }) {
  if (props.outcome.state === "passed") {
    return <text fg={props.api.theme.current.success}>{glyphs.ok} PASSED — exit 0</text>
  }
  if (props.outcome.state === "failed") {
    return <text fg={props.api.theme.current.error}>{glyphs.no} FAILED — clean exit {props.outcome.exit_code}</text>
  }
  return (
    <text fg={props.api.theme.current.error}>
      {glyphs.warn} KILLED — {props.outcome.reason}
      {props.outcome.exit_code === undefined ? "" : `; exit ${props.outcome.exit_code}`}
    </text>
  )
}

function Confinement(props: { readonly api: TuiPluginApi; readonly confinement: RunConfinement }) {
  if (props.confinement.state === "unconfined") {
    return (
      <box>
        <text fg={props.api.theme.current.error}>
          {glyphs.warn} CONFINEMENT UNCONFINED — {props.confinement.reason}
        </text>
        <Row api={props.api} label="filesystem" value="unrestricted; confinement not applied" />
        <Row api={props.api} label="network" value="unrestricted; confinement not applied" />
        <Row api={props.api} label="cgroup" value="no limits applied" />
      </box>
    )
  }
  return (
    <box>
      <text fg={props.api.theme.current.success}>{glyphs.ok} CONFINEMENT CONFINED — applied</text>
      <Row api={props.api} label="filesystem" value={props.confinement.filesystem_scope} />
      <Row api={props.api} label="network" value={props.confinement.network_posture} />
      <Row api={props.api} label="cgroup" value={props.confinement.cgroup_limits} />
    </box>
  )
}

function Row(props: { readonly api: TuiPluginApi; readonly label: string; readonly value: string }) {
  return (
    <box flexDirection="row" gap={1}>
      <text width={14} fg={props.api.theme.current.textMuted}>
        {props.label}
      </text>
      <text flexGrow={1} fg={props.api.theme.current.text}>
        {props.value}
      </text>
    </box>
  )
}

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) return `${durationMs}ms`
  return `${(durationMs / 1_000).toFixed(1)}s`
}

function Run(props: BoardPaneProps) {
  if (props.data.state === "unread") {
    return (
      <box gap={1}>
        <text fg={props.api.theme.current.warning}>{glyphs.warn} Run unavailable.</text>
        <text fg={props.api.theme.current.text}>No run record was read.</text>
        <text fg={props.api.theme.current.textMuted}>{props.data.why}</text>
      </box>
    )
  }

  return (
    <box gap={1}>
      <text fg={props.api.theme.current.warning}>{glyphs.warn} Run details unavailable.</text>
      <text fg={props.api.theme.current.text}>A verdict was read, but no run record was provided.</text>
      <text fg={props.api.theme.current.textMuted}>subject {props.data.record.subject_digest}</text>
    </box>
  )
}

export const RunPane = {
  id: "ranex.board.run",
  title: "Run",
  order: 400,
  render: (props) => <Run {...props} />,
} satisfies import("../pane").BoardPane
