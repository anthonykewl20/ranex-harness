import { useTerminalDimensions } from "@opentui/solid"
import { createMemo } from "solid-js"
import { useTheme } from "../../../context/theme"
import { filetype } from "../../../util/filetype"

/**
 * CHAT-08 — file changes, and the one place this design starts ahead.
 *
 * `visual-identity.md` gates every status-on-tint pair at 4.5:1 **in the
 * generator**, which writes nothing when a floor is breached. That is why
 * claude-code #67783 (bold text invisible on deleted-red) and #40825 (diff text
 * invisible in light terminals) cannot ship here: they would fail the build
 * rather than reach a screen.
 *
 * The rule this adds on top, from claude-code #73951 — where Write rendered
 * without added-line highlighting *unlike Edit*: **a file change renders
 * identically regardless of which tool produced it.** So every tool routes here
 * rather than each drawing its own, which is the structural version of that fix.
 */
export function Diff(props: { content: string; path?: string }) {
  const { theme, syntax } = useTheme()
  const dimensions = useTerminalDimensions()

  // Split needs room for two gutters and two bodies; below that it lies about
  // alignment. Unified is the honest fallback rather than a squeezed split.
  const view = createMemo(() => (dimensions().width > 120 ? "split" : "unified"))
  const ft = createMemo(() => filetype(props.path ?? ""))

  return (
    <box paddingLeft={1}>
      <diff
        diff={props.content}
        view={view()}
        filetype={ft()}
        syntaxStyle={syntax()}
        showLineNumbers={true}
        width="100%"
        fg={theme.text}
      />
    </box>
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
