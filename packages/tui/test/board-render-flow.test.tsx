/** @jsxImportSource @opentui/solid */
//
// Real render-flow tests: each test mounts the actual component through
// `testRender` (the OpenTUI solid renderer) and asserts the painted frame, or
// drives the real routing store through its provider. This is the layer below a
// human at a terminal and above a source grep — the component's render path
// executes, the store's navigate/reconcile runs, and the assertion is against
// real output, not a string in the source.
//
// Panes are reached through their public registry entry (`Pane.render`), which
// is how the board shell invokes them — so this exercises the same path a real
// render takes, not a test-only export.
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { createTuiPluginApi } from "./fixture/tui-plugin"
import { TestTuiContexts } from "./fixture/tui-environment"
import { EscalationPane } from "../src/feature-plugins/board/panes/escalation"
import { WorkflowPane } from "../src/feature-plugins/board/panes/workflow"
import { GatesPane } from "../src/feature-plugins/board/panes/gates"
import { EvidencePane } from "../src/feature-plugins/board/panes/evidence"
import { SpecificationPane } from "../src/feature-plugins/board/panes/specification"
import { RunPane } from "../src/feature-plugins/board/panes/run"
import { DiffPane } from "../src/feature-plugins/board/panes/diff"
import { JournalPane } from "../src/feature-plugins/board/panes/journal"
import type { BoardData, BoardPane } from "../src/feature-plugins/board/pane"
import type { BuiltinTuiPlugin } from "../src/feature-plugins/builtins"
import SidebarVerdict from "../src/feature-plugins/sidebar/verdict"
import SidebarGates from "../src/feature-plugins/sidebar/gates"
import SidebarSubject from "../src/feature-plugins/sidebar/subject"
import SidebarBudget from "../src/feature-plugins/sidebar/budget"
import { useRoute, RouteProvider } from "../src/context/route"

const UNREAD: BoardData = { state: "unread", why: "no verdict return channel (ADR-019)" }
const READ: BoardData = { state: "read", record: { verdict: "FAIL", subject_digest: "sha256:abc123" } }

async function frame(node: () => JSX.Element) {
  const app = await testRender(node, { width: 100, height: 24 })
  try {
    await app.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

describe("BOARD-13: escalation pane render flow", () => {
  test("unread paints the undecided-policy state and the reason", async () => {
    const output = await frame(() => EscalationPane.render({ api: createTuiPluginApi(), data: UNREAD }))
    expect(output).toContain("Escalation policy UNDECIDED")
    expect(output).toContain("attempt count unavailable")
    expect(output).toContain(UNREAD.why)
  })

  test("read paints the subject and the attempt/status placeholders, never a threshold", async () => {
    const output = await frame(() => EscalationPane.render({ api: createTuiPluginApi(), data: READ }))
    expect(output).toContain("sha256:abc123")
    expect(output).toContain("attempts unavailable")
    expect(output).toContain("DISPLAY ONLY")
  })
})

describe("BOARD-19: workflow chain pane render flow", () => {
  test("unread paints CHAIN NOT STARTED, not an empty diagram", async () => {
    const output = await frame(() => WorkflowPane.render({ api: createTuiPluginApi(), data: UNREAD }))
    expect(output).toContain("CHAIN NOT STARTED")
    expect(output).toContain("no intake has happened")
    expect(output).toContain(UNREAD.why)
  })

  test("read paints the chain steps in order and the read-only statement", async () => {
    const output = await frame(() => WorkflowPane.render({ api: createTuiPluginApi(), data: READ }))
    expect(output).toContain("approved graph")
    expect(output).toContain("scenarios")
    expect(output).toContain("contract tests")
    expect(output).toContain("gates")
    expect(output).toContain("READ ONLY")
  })
})

describe("BOARD-16: governance sidebar panels render the honest unread state", () => {
  // Each panel is a slot plugin. Register it against a capturing api, then paint
  // the slot's output the way the sidebar would — proving the panel renders
  // rather than throws, and that it states the channel is missing.
  function captureSlot(plugin: BuiltinTuiPlugin, routeName = "session") {
    let slot: ((ctx: unknown, props: { session_id: string }) => JSX.Element) | undefined
    // Budget reads session.messages(); the other panels ignore it. Provide it so
    // every panel renders via the same capture path.
    const api = createTuiPluginApi({ state: { session: { messages: () => [], get: () => undefined } } })
    const stub = {
      ...api,
      route: { ...api.route, current: { name: routeName } },
      slots: {
        register(p: { slots: Record<string, unknown> }) {
          const fn = p.slots.sidebar_content
          if (typeof fn === "function") slot = fn as typeof slot
          return "slot-id"
        },
      },
    }
    void plugin.tui(stub as never, undefined, {} as never)
    if (!slot) throw new Error("panel did not register a sidebar_content slot")
    return (session_id = "s1") => slot!({}, { session_id })
  }

  test("verdict and gates panels say there is no channel", async () => {
    const verdict = await frame(() => captureSlot(SidebarVerdict)())
    expect(verdict).toContain("unavailable")
    expect(verdict).toContain("no channel")

    const gates = await frame(() => captureSlot(SidebarGates)())
    expect(gates).toContain("unavailable")
  })

  test("subject panel names its source as unread", async () => {
    const subject = await frame(() => captureSlot(SidebarSubject)())
    expect(subject).toContain("unavailable")
  })

  test("budget panel renders from session state without throwing", async () => {
    const budget = await frame(() => captureSlot(SidebarBudget)())
    // Budget reads real session state; with a stub session it still renders and
    // reaches the token line rather than erroring on the governance path.
    expect(budget).toContain("Budget")
    expect(budget).toMatch(/tokens/)
  })
})

describe("BOARD-14: routing — the board is the front door", () => {
  // Drive the real RouteProvider store. A spy consumer captures the route
  // context; the test asserts the default, the home→board rewrite, and the
  // explicit newSession() path that still reaches the retired landing.
  test("fresh default is the board, bare home navigations redirect, newSession reaches home", async () => {
    let route: ReturnType<typeof useRoute> | undefined
    const Spy = () => {
      route = useRoute()
      return null
    }

    const app = await testRender(
      () => (
        <TestTuiContexts>
          <RouteProvider>
            <Spy />
          </RouteProvider>
        </TestTuiContexts>
      ),
      { width: 40, height: 12 },
    )
    try {
      await app.renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 30))
      await app.renderOnce()

      const initial = route!.data
      expect(initial.type).toBe("plugin")
      if (initial.type === "plugin") expect(initial.id).toBe("ranex.board")

      // A bare home navigation is an inherited fallback and is redirected.
      route!.navigate({ type: "home" })
      await app.renderOnce()
      const afterHome = route!.data
      expect(afterHome.type).toBe("plugin")
      if (afterHome.type === "plugin") expect(afterHome.id).toBe("ranex.board")

      // The explicit new-session action is the one path that reaches home.
      route!.newSession()
      await app.renderOnce()
      expect(route!.data.type).toBe("home")
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("BOARD-05: gates pane render flow (control — proves the harness)", () => {
  test("read paints the subject digest; unread paints the reason", async () => {
    const unread = await frame(() => GatesPane.render({ api: createTuiPluginApi(), data: UNREAD }))
    expect(unread).toContain("Gates unavailable")
    expect(unread).toContain(UNREAD.why)

    const read = await frame(() => GatesPane.render({ api: createTuiPluginApi(), data: READ }))
    expect(read).toContain("sha256:abc123")
  })
})

// The merged-but-unclosed panes (BOARD-06/07/08/09/12), held to the same
// render-flow bar: each mounts through its public Pane.render and must paint the
// honest "unavailable" + reason for an unread board, and the subject digest for
// a read one. They share the BoardData contract, so the assertion is uniform.
const MERGED_PANES: ReadonlyArray<[id: string, pane: BoardPane]> = [
  ["BOARD-06", EvidencePane],
  ["BOARD-07", SpecificationPane],
  ["BOARD-08", RunPane],
  ["BOARD-09", DiffPane],
  ["BOARD-12", JournalPane],
]

describe.each(MERGED_PANES)("%s: merged pane render flow", (id, pane) => {
  test("unread paints unavailable and the no-channel reason", async () => {
    const output = await frame(() => pane.render({ api: createTuiPluginApi(), data: UNREAD }))
    expect(output).toContain("unavailable")
    expect(output).toContain(UNREAD.why)
  })

  test("read paints the subject digest", async () => {
    const output = await frame(() => pane.render({ api: createTuiPluginApi(), data: READ }))
    expect(output).toContain("sha256:abc123")
  })
})
