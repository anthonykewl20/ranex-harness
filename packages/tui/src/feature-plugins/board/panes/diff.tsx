import type { TuiPluginApi } from "@ranex/plugin/tui"
import { Match, Show, Switch, createMemo } from "solid-js"
import { detectGlyphs } from "../../../theme/glyphs"
import { DIFF_VIEWER_ROUTE } from "../../system/diff-viewer"
import { subjectDiffBindingState, type SubjectDiffBinding } from "../diff-binding"
import type { BoardPaneProps } from "../pane"

const glyphs = detectGlyphs()

export function openSubjectDiff(api: TuiPluginApi, binding: SubjectDiffBinding) {
  api.route.navigate(DIFF_VIEWER_ROUTE, {
    mode: "git",
    subjectBinding: binding,
    returnRoute: api.route.current,
  })
  api.ui.dialog.clear()
}

export function DiffDetails(props: { readonly api: TuiPluginApi; readonly binding: SubjectDiffBinding }) {
  const theme = () => props.api.theme.current
  const state = () => subjectDiffBindingState(props.binding)
  const additions = createMemo(() => props.binding.files.reduce((total, file) => total + file.additions, 0))
  const deletions = createMemo(() => props.binding.files.reduce((total, file) => total + file.deletions, 0))

  return (
    <box gap={1}>
      <DigestRow api={props.api} label="verdict subject" digest={props.binding.verdictDigest} />
      <DigestRow api={props.api} label="diff tree" digest={props.binding.diffDigest} />
      <DigestRow api={props.api} label="working tree" digest={props.binding.workingTreeDigest} />

      <Switch>
        <Match when={state() === "mismatched"}>
          <text fg={theme().error}>
            {glyphs.no} REFUSED — diff digest {props.binding.diffDigest} does not match verdict digest{" "}
            {props.binding.verdictDigest}.
          </text>
          <text fg={theme().error}>REVIEW STATE: REFUSED — this diff cannot render as the reviewed change.</text>
        </Match>
        <Match when={state() === "stale"}>
          <text fg={theme().warning}>
            {glyphs.warn} STALE — working tree moved since the verdict; only the bound snapshot may be shown.
          </text>
          <text fg={theme().warning}>
            REVIEW STATE: STALE — recorded {props.binding.reviewState === "reviewed" ? "REVIEWED" : "NOT REVIEWED"} state
            belongs to {props.binding.verdictDigest}, not the current tree.
          </text>
        </Match>
        <Match when={state() === "current"}>
          <text fg={theme().success}>{glyphs.ok} BOUND — diff and verdict name the same current tree.</text>
          <text fg={props.binding.reviewState === "reviewed" ? theme().success : theme().warning}>
            REVIEW STATE: {props.binding.reviewState === "reviewed" ? "REVIEWED — independently read." : "NOT REVIEWED — nobody independent has read this."}
          </text>
        </Match>
      </Switch>

      <Show when={state() !== "mismatched"}>
        <Show
          when={props.binding.files.length > 0}
          fallback={<text fg={theme().text}>no change — the bound subject contains no changed files.</text>}
        >
          <box flexDirection="row" gap={2}>
            <text fg={theme().diffAdded}>+{additions()} added</text>
            <text fg={theme().diffRemoved}>-{deletions()} removed</text>
            <text fg={theme().textMuted}>
              {props.binding.files.length} {props.binding.files.length === 1 ? "file" : "files"}
            </text>
          </box>
        </Show>
      </Show>

      <text fg={theme().textMuted}>Reviewing is not approving. This pane records no verdict.</text>
      <text
        fg={state() === "mismatched" ? theme().error : theme().primary}
        onMouseUp={() => openSubjectDiff(props.api, props.binding)}
      >
        {state() === "mismatched" ? "open refusal in existing diff viewer" : "open bound diff in existing viewer"}
      </text>
    </box>
  )
}

function DigestRow(props: { readonly api: TuiPluginApi; readonly label: string; readonly digest: string }) {
  return (
    <box flexDirection="row" gap={1}>
      <text width={18} fg={props.api.theme.current.textMuted}>
        {props.label}
      </text>
      <text flexGrow={1} fg={props.api.theme.current.text}>
        {props.digest}
      </text>
    </box>
  )
}

function Diff(props: BoardPaneProps) {
  if (props.data.state === "unread") {
    return (
      <box gap={1}>
        <text fg={props.api.theme.current.warning}>{glyphs.warn} Diff unavailable.</text>
        <text fg={props.api.theme.current.text}>No verdict or subject-bound diff was read.</text>
        <text fg={props.api.theme.current.textMuted}>{props.data.why}</text>
      </box>
    )
  }

  return (
    <box gap={1}>
      <text fg={props.api.theme.current.warning}>{glyphs.warn} Subject-bound diff unavailable.</text>
      <text fg={props.api.theme.current.text}>A verdict was read, but no diff snapshot was provided.</text>
      <text fg={props.api.theme.current.textMuted}>verdict subject {props.data.record.subject_digest}</text>
      <text fg={props.api.theme.current.textMuted}>A fresh working-tree diff is never substituted under this verdict.</text>
    </box>
  )
}

export const DiffPane = {
  id: "ranex.board.diff",
  title: "Diff",
  order: 500,
  render: (props) => <Diff {...props} />,
} satisfies import("../pane").BoardPane
