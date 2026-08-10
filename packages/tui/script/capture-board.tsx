#!/usr/bin/env bun
/**
 * Render the board with the real renderer and dump the frame it actually paints.
 *
 * Not a mockup. This drives OpenTUI's test renderer over the same components the
 * harness ships, with the generated Ranex theme resolved through the same
 * `resolveTheme` + `degrade` path, and captures the cells that come out.
 *
 *   bun run packages/tui/script/capture-board.tsx > frame.json
 */
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { DEFAULT_THEMES, resolveTheme } from "../src/theme"
import { degrade, type ColorCapability } from "../src/theme/capability"
import { detectGlyphs } from "../src/theme/glyphs"

const WIDTH = 92
const HEIGHT = 26

const glyphs = detectGlyphs({ LANG: "en_US.UTF-8", TERM: "xterm-256color" })

/** The board's empty state, lifted from feature-plugins/board so the capture
 * needs no plugin runtime. Kept literal: if it drifts from the component, the
 * capture is a lie. */
function Board(props: { theme: ReturnType<typeof resolveTheme> }) {
  const theme = props.theme
  return (
    <box padding={2} gap={1} flexGrow={1} backgroundColor={theme.background}>
      <text fg={theme.primary}>
        <b>ranex</b>
      </text>
      <box gap={1}>
        <text fg={theme.text}>Nothing to judge yet.</text>
        <box>
          <text fg={theme.textMuted}>This board shows whether work is acceptable, and</text>
          <text fg={theme.textMuted}>why not. It is empty because no verdict has been</text>
          <text fg={theme.textMuted}>read for this repository.</text>
        </box>
        <box>
          <text fg={theme.warning}>{glyphs.warn} No channel to read one exists yet.</text>
          <text fg={theme.textMuted}> The bridge emits to the kernel; nothing returns.</text>
          <text fg={theme.textMuted}> Tracked as BOARD-01.</text>
        </box>
        <box>
          <text fg={theme.text}>Until then, judge from the CLI:</text>
          <text fg={theme.textMuted}> ranex gate evaluate {"<ref>"} --approver {"<you>"}</text>
        </box>
      </box>
    </box>
  )
}

/** A populated board, so the palette can be seen carrying a real verdict. */
function Populated(props: { theme: ReturnType<typeof resolveTheme> }) {
  const theme = props.theme
  const row = (gate: string, evidence: string, verdict: string, cause?: string) => (
    <box flexDirection="row">
      <text fg={theme.text}>{gate.padEnd(18)}</text>
      <text fg={theme.textMuted}>{evidence.padEnd(22)}</text>
      <text fg={verdict === "PASS" ? theme.success : theme.error}>
        <b>{verdict.padEnd(8)}</b>
      </text>
      <text fg={theme.warning}>{cause ?? ""}</text>
    </box>
  )
  return (
    <box padding={2} gap={1} flexGrow={1} backgroundColor={theme.background}>
      <box flexDirection="row">
        <text fg={theme.primary}>
          <b>SPEC-014</b>
        </text>
        <text fg={theme.text}> rate-limit the login route</text>
      </box>
      <text fg={theme.textMuted}>subject sha256:15d70fd2b7bf9f19… lane PRE_READINESS</text>
      <text fg={theme.borderSubtle}>{glyphs.rule.repeat(WIDTH - 8)}</text>
      <box>
        <box flexDirection="row">
          <text fg={theme.textMuted}>{"GATE".padEnd(18)}</text>
          <text fg={theme.textMuted}>{"EVIDENCE".padEnd(22)}</text>
          <text fg={theme.textMuted}>{"VERDICT".padEnd(8)}</text>
          <text fg={theme.textMuted}>CAUSE</text>
        </box>
        {row("tests-frozen", "manifest @15d70fd2", "PASS")}
        {row("red-then-green", "red then green", "PASS")}
        {row("tests-executed", "2 records refused", "FAIL", "refused")}
        {row("diff-reviewed", "none recorded", "FAIL", "absent")}
        {row("no-self-approve", "approver=owner", "PASS")}
      </box>
      <text fg={theme.borderSubtle}>{glyphs.rule.repeat(WIDTH - 8)}</text>
      <box flexDirection="row">
        <text fg={theme.text}>VERDICT </text>
        <text fg={theme.error}>
          <b>FAIL</b>
        </text>
        <text fg={theme.textMuted}> rule=TESTS_EXECUTED</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.textMuted}>{glyphs.right} diff </text>
        <text fg={theme.text}>src/auth/login.ts </text>
        <text fg={theme.diffAdded}>+24</text>
        <text fg={theme.text}> </text>
        <text fg={theme.diffRemoved}>-3</text>
      </box>
    </box>
  )
}

const SHOTS = [
  { id: "board-empty-dark", mode: "dark", capability: "truecolor", view: "empty" },
  { id: "board-dark", mode: "dark", capability: "truecolor", view: "full" },
  { id: "board-light", mode: "light", capability: "truecolor", view: "full" },
  { id: "board-ansi16", mode: "dark", capability: "ansi16", view: "full" },
  { id: "board-none", mode: "dark", capability: "none", view: "full" },
] as const

const out: Record<string, unknown> = {}

for (const shot of SHOTS) {
  const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT })
  const theme = degrade(
    resolveTheme(DEFAULT_THEMES.ranex, shot.mode),
    shot.capability as ColorCapability,
  )
  render(
    () => (shot.view === "empty" ? <Board theme={theme} /> : <Populated theme={theme} />),
    setup.renderer,
  )
  await setup.flush()
  const frame = setup.captureSpans()
  out[shot.id] = {
    ...shot,
    cols: frame.cols,
    rows: frame.rows,
    lines: frame.lines.map((line) => ({
      spans: line.spans.map((span) => ({
        text: span.text,
        fg: span.fg.toString(),
        bg: span.bg.toString(),
        attributes: span.attributes,
      })),
    })),
  }
  setup.renderer.destroy()
}

console.log(JSON.stringify(out, null, 0))
