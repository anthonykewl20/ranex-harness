import type { TuiPlugin, TuiPluginApi } from "@ranex/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { Show, createMemo } from "solid-js"
import { detectGlyphs } from "../../theme/glyphs"

/**
 * The fields this shell reads, structurally.
 *
 * Deliberately not imported from `@ranex/schema`: the SDK is the TUI's boundary
 * (`specs/tui-package.md`), and missing backend data belongs in the server API
 * and generated SDK rather than a direct dependency on a backend contract
 * package. `packages/schema/src/verdict.ts` is the authority on the full shape;
 * when BOARD-01's read channel exists, the type arrives with the data path and
 * this local declaration goes away.
 */
type VerdictRecord = {
  verdict: "PASS" | "FAIL"
  subject_digest: string
}

export const ROUTE = "ranex.board"

const glyphs = detectGlyphs()

/**
 * The governance board — ADR-018, BOARD-04.
 *
 * Registered as a plugin route rather than a new `Route` variant, so `app.tsx`
 * and `context/route.tsx` are untouched. `packages/tui` sits about 163
 * insertions from the opencode fork base, and every upstream file this avoids
 * editing is one that keeps merging cleanly. Deleting this directory returns
 * the harness to stock behaviour, which is what makes ADR-018 a two-way door.
 */
function Board(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  /**
   * There is no verdict, and there is no way to read one yet.
   *
   * The bridge is one-directional: `plugin/ranex.ts` appends
   * `{task_id, worktree, commit}` to `RANEX_EMIT` on session idle, and nothing
   * comes back. BOARD-01 carries the contract; the channel is kernel-side work.
   *
   * Typed against the real contract so that wiring the channel is a change of
   * source, not a change of shape.
   */
  const verdict = createMemo<VerdictRecord | undefined>(() => undefined)

  return (
    <box padding={2} gap={1} flexGrow={1}>
      <text fg={theme().primary}>
        <b>ranex</b>
      </text>

      <Show
        when={verdict()}
        fallback={
          <box gap={1}>
            <text fg={theme().text}>Nothing to judge yet.</text>

            <box>
              <text fg={theme().textMuted}>This board shows whether work is acceptable, and</text>
              <text fg={theme().textMuted}>why not. It is empty because no verdict has been</text>
              <text fg={theme().textMuted}>read for this repository.</text>
            </box>

            {/*
              Said plainly rather than dressed as an empty success. A board that
              renders an encouraging blank screen when it cannot see a verdict is
              the failure this whole project exists to remove.
            */}
            <box>
              <text fg={theme().warning}>{glyphs.warn} No channel to read one exists yet.</text>
              <text fg={theme().textMuted}> The bridge emits to the kernel; nothing returns.</text>
              <text fg={theme().textMuted}> Tracked as BOARD-01.</text>
            </box>

            <box>
              <text fg={theme().text}>Until then, judge from the CLI:</text>
              <text fg={theme().textMuted}> ranex gate evaluate {"<ref>"} --approver {"<you>"}</text>
            </box>
          </box>
        }
      >
        {(record) => (
          <box gap={1}>
            <text fg={record().verdict === "PASS" ? theme().success : theme().error}>
              <b>{record().verdict}</b>
            </text>
            <text fg={theme().textMuted}>subject {record().subject_digest}</text>
          </box>
        )}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <Board api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "board.open",
        title: "Open the governance board",
        slashName: "board",
        category: "Ranex",
        namespace: "palette",
        run() {
          api.route.navigate(ROUTE, { returnRoute: api.route.current })
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = {
  id: "ranex-board",
  tui,
}

export default plugin
