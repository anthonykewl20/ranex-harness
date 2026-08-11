import { useTerminalDimensions } from "@opentui/solid"
import { createMemo } from "solid-js"
import { useTheme } from "../../../context/theme"
import { filetype } from "../../../util/filetype"
import { Panel } from "./output"

/**
 * CHAT-08 — file changes, contained.
 *
 * An unframed run of `+` lines is a wall: it has no edges, so the eye cannot
 * tell where the change starts, where it ends, or where it sits relative to the
 * conversation around it. This gives it a **frame, a header and a body** — the
 * shape of an editor pane — so a change reads as an object rather than as more
 * transcript.
 *
 * The header states path and size before the body is read. That is the same
 * rule as the collapsed tool line: say what happened, then show it.
 *
 * `visual-identity.md` gates every status-on-tint pair at 4.5:1 in the
 * generator, which is why claude-code #67783 (bold text invisible on
 * deleted-red) and #40825 (diff text invisible in light terminals) cannot ship
 * here — they fail the build rather than reach a screen.
 *
 * The rule this adds, from claude-code #73951 where Write rendered without
 * added-line highlighting *unlike Edit*: **a file change renders identically
 * regardless of which tool produced it.** Every tool routes through here.
 */
export function Diff(props: { content: string; path?: string; stat?: string }) {
  const { theme, syntax } = useTheme()
  const dimensions = useTerminalDimensions()

  // Split needs room for two gutters and two bodies; below that it lies about
  // alignment. Unified is the honest fallback, not a squeezed split.
  const view = createMemo(() => (dimensions().width > 120 ? "split" : "unified"))
  const ft = createMemo(() => filetype(props.path ?? ""))

  return (
    <Panel title={props.path} detail={props.stat}>
      <diff
        diff={props.content}
        view={view()}
        filetype={ft()}
        syntaxStyle={syntax()}
        showLineNumbers={true}
        width="100%"
        fg={theme.text}
      />
    </Panel>
  )
}

/**
 * The diff a tool produced, or undefined.
 *
 * Read from `state.metadata.diff`, the same field `routes/session` reads, so the
 * two surfaces cannot disagree about whether a change happened.
 */
export function toolDiff(state: { metadata?: Record<string, unknown> } | undefined): string | undefined {
  const diff = state?.metadata?.diff
  return typeof diff === "string" && diff.length > 0 ? diff : undefined
}
