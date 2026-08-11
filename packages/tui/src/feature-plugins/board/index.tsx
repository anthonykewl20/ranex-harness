import type { TuiPlugin, TuiPluginApi } from "@ranex/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { For, Show, createMemo } from "solid-js"
import { useBindings } from "../../keymap"
import { detectGlyphs } from "../../theme/glyphs"
import { PaneFrame, type BoardData } from "./pane"
import { PANES } from "./panes"

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

  const params = () =>
    "params" in props.api.route.current
      ? (props.api.route.current.params as { returnRoute?: { name: string } } | undefined)
      : undefined

  /**
   * A route you can enter and not leave is a trap, and this one was: the route
   * registered, the command opened it, and nothing bound a way back. Escape and
   * `q` both return, and the footer says so on screen — a keybinding nobody can
   * see is not an exit.
   */
  const commands = [
    {
      name: "board.close",
      title: "Close the board",
      category: "Ranex",
      run() {
        const back = params()?.returnRoute
        props.api.ui.dialog.clear()
        props.api.route.navigate(
          back?.name ?? "home",
          back && "params" in back ? (back as { params?: Record<string, unknown> }).params : undefined,
        )
      },
    },
  ]

  useBindings(() => ({
    commands,
    bindings: [{ key: "escape,q", cmd: "board.close", desc: "Close the board" }],
  }))

  /**
   * There is no verdict, and there is no way to read one yet.
   *
   * The bridge is one-directional: `plugin/ranex.ts` appends
   * `{task_id, worktree, commit}` to `RANEX_EMIT` on session idle, and nothing
   * comes back. ADR-019 decides the return channel; until it is built, every
   * pane is handed `unread` and must say so in its own terms.
   *
   * Carried as a tagged union rather than an optional record so that wiring the
   * channel is a change of source, not a change of shape — and so no pane can
   * render as though a verdict arrived when none did.
   */
  const data = createMemo<BoardData>(() => ({
    state: "unread",
    why: "no channel exists to read one; the bridge emits to the kernel and nothing returns",
  }))

  const panes = createMemo(() => [...PANES].sort((a, b) => a.order - b.order))

  return (
    <box padding={2} gap={1} flexGrow={1}>
      <text fg={theme().primary}>
        <b>ranex</b>
      </text>

      <Show when={data().state === "read"} fallback={<Unread api={props.api} why={unreadWhy(data())} />}>
        {/*
          The read state renders nothing of its own. Every field belongs to a
          pane, and a pane that has not been built yet must not be stubbed here —
          a placeholder in the shell is how the shell quietly becomes the board.
        */}
        <box />
      </Show>

      <For each={panes()}>
        {(pane) => (
          <PaneFrame api={props.api} title={pane.title}>
            {pane.render({ api: props.api, data: data() })}
          </PaneFrame>
        )}
      </For>

      <box flexDirection="row" gap={1}>
        <text fg={theme().primary}>
          <b>esc</b>
        </text>
        <text fg={theme().textMuted}>back</text>
        <text fg={theme().primary}>
          <b>q</b>
        </text>
        <text fg={theme().textMuted}>back</text>
      </box>
    </box>
  )
}

function unreadWhy(data: BoardData): string {
  return data.state === "unread" ? data.why : ""
}

/**
 * Said plainly rather than dressed as an empty success. A board that renders an
 * encouraging blank screen when it cannot see a verdict is the failure this
 * whole project exists to remove.
 */
function Unread(props: { api: TuiPluginApi; why: string }) {
  const theme = () => props.api.theme.current

  return (
    <box gap={1}>
      <text fg={theme().text}>Nothing to judge yet.</text>

      <box>
        <text fg={theme().textMuted}>This board shows whether work is acceptable, and</text>
        <text fg={theme().textMuted}>why not. It is empty because no verdict has been</text>
        <text fg={theme().textMuted}>read for this repository.</text>
      </box>

      <box>
        <text fg={theme().warning}>{glyphs.warn} No verdict was read.</text>
        <text fg={theme().textMuted}> {props.why}</text>
        <text fg={theme().textMuted}> Tracked as BOARD-01; the channel is ADR-019.</text>
      </box>

      <box>
        <text fg={theme().text}>Until then, judge from the CLI:</text>
        <text fg={theme().textMuted}> ranex gate evaluate {"<ref>"} --approver {"<you>"}</text>
      </box>
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
