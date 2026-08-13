import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { KNOWN_CAUSES } from "@ranex/schema/verdict"
import {
  GATE_PAGE_SIZE,
  GateTable,
  GatesPane,
  paginateGateRows,
  type GateRow,
} from "../src/feature-plugins/board/panes/gates"
import { createTuiPluginApi } from "./fixture/tui-plugin"

async function capture(render: () => ReturnType<typeof GatesPane.render>, height = 24) {
  const app = await testRender(render, { width: 120, height })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

function gate(overrides: Partial<GateRow> = {}): GateRow {
  return {
    gate: "tests-executed",
    evidence: "pytest observed",
    verdict: "FAIL",
    causes: ["failed"],
    ...overrides,
  }
}

describe("the gates pane", () => {
  test("registers the reserved identity and order", () => {
    expect(GatesPane).toMatchObject({ id: "ranex.board.gates", title: "Gates", order: 100 })
  })

  test("renders unread as unavailable, never as an empty reassuring table", async () => {
    const frame = await capture(() =>
      GatesPane.render({
        api: createTuiPluginApi(),
        data: { state: "unread", why: "the return channel does not exist" },
      }),
    )

    expect(frame).toContain("Gates unavailable")
    expect(frame).toContain("No gate verdicts were read")
    expect(frame).toContain("the return channel does not exist")
    expect(frame).not.toContain("0 pass")
  })

  test("renders an all-absent fixture as blocked work never done", async () => {
    const rows = [
      gate({ gate: "tests-frozen", evidence: "none recorded", causes: ["absent"] }),
      gate({ gate: "diff-reviewed", evidence: "none recorded", causes: ["absent"] }),
    ]
    const frame = await capture(() => GateTable({ api: createTuiPluginApi(), rows, page: 0 }))

    expect(frame).toContain("tests-frozen")
    expect(frame).toContain("diff-reviewed")
    expect(frame.match(/FAIL/g)).toHaveLength(2)
    expect(frame.match(/absent — work never done/g)).toHaveLength(2)
  })

  test("renders an unknown wire cause as unclassified and blocking", async () => {
    const frame = await capture(() =>
      GateTable({
        api: createTuiPluginApi(),
        rows: [gate({ verdict: "FAIL", causes: ["new-kernel-cause"] })],
        page: 0,
      }),
    )

    expect(frame).toContain("FAIL")
    expect(frame).toContain("unclassified — unknown cause; blocks")
    expect(frame).not.toContain("new-kernel-cause")
  })

  test("renders every authoritative cause by name", async () => {
    const frame = await capture(
      () =>
        GateTable({
          api: createTuiPluginApi(),
          rows: [gate({ causes: KNOWN_CAUSES })],
          page: 0,
        }),
      30,
    )

    expect(KNOWN_CAUSES).toHaveLength(7)
    for (const cause of KNOWN_CAUSES) expect(frame).toContain(cause)
    expect(frame).not.toContain("unclassified")
  })

  // Derived from GATE_PAGE_SIZE throughout, never from numbers measured on the
  // machine that happened to run it first. This repository froze measurements as
  // acceptance values seven times in one slice; changing the page size should
  // move this test, not break it.
  test("paginates long gate lists without rendering every row", () => {
    const total = GATE_PAGE_SIZE * 100
    const name = (index: number) => `gate-${String(index).padStart(4, "0")}`
    const rows = Array.from({ length: total }, (_, index) => gate({ gate: name(index) }))
    const first = paginateGateRows(rows, 0)
    const last = paginateGateRows(rows, Number.MAX_SAFE_INTEGER)

    expect(first.rows).toHaveLength(GATE_PAGE_SIZE)
    expect(first.rows[0]?.gate).toBe(name(0))
    expect(first.rows.at(-1)?.gate).toBe(name(GATE_PAGE_SIZE - 1))

    expect(last.pageCount).toBe(total / GATE_PAGE_SIZE)
    expect(last.page).toBe(last.pageCount - 1)
    expect(last.rows).toHaveLength(GATE_PAGE_SIZE)
    expect(last.rows[0]?.gate).toBe(name(total - GATE_PAGE_SIZE))
    expect(last.rows.at(-1)?.gate).toBe(name(total - 1))
  })

  // The assertion that matters, and the one the first version of this pane
  // failed: a page that does not fit drops its last rows off the bottom of the
  // terminal and says nothing. Silent truncation is the one kind this project
  // does not permit, so every row of the page must be on screen, and so must the
  // control for leaving it.
  test("renders every row of a page, and its pager, inside an ordinary terminal", async () => {
    const total = GATE_PAGE_SIZE * 3
    const name = (index: number) => `gate-${String(index).padStart(4, "0")}`
    const rows = Array.from({ length: total }, (_, index) => gate({ gate: name(index) }))
    const frame = await capture(() => GateTable({ api: createTuiPluginApi(), rows, page: 0 }), 24)

    for (let index = 0; index < GATE_PAGE_SIZE; index += 1) {
      expect(frame).toContain(name(index))
    }
    expect(frame).not.toContain(name(GATE_PAGE_SIZE))
    expect(frame).toContain(`page 1 of ${total / GATE_PAGE_SIZE}`)
  })

  test("preserves wire cause order instead of imposing an order", async () => {
    const first = await capture(() =>
      GateTable({
        api: createTuiPluginApi(),
        rows: [gate({ causes: ["stale", "failed", "absent", "refused"] })],
        page: 0,
      }),
    )
    const second = await capture(() =>
      GateTable({
        api: createTuiPluginApi(),
        rows: [gate({ causes: ["refused", "absent", "failed", "stale"] })],
        page: 0,
      }),
    )

    expect(first.indexOf("stale")).toBeLessThan(first.indexOf("failed"))
    expect(first.indexOf("failed")).toBeLessThan(first.indexOf("absent"))
    expect(first.indexOf("absent")).toBeLessThan(first.indexOf("refused"))
    expect(second.indexOf("refused")).toBeLessThan(second.indexOf("absent"))
    expect(second.indexOf("absent")).toBeLessThan(second.indexOf("failed"))
    expect(second.indexOf("failed")).toBeLessThan(second.indexOf("stale"))
  })

  test("concatenating pages preserves every gate in input order", () => {
    const rows = Array.from({ length: 57 }, (_, index) => gate({ gate: `gate-${index}` }))
    const pageCount = paginateGateRows(rows, 0).pageCount
    const paged = Array.from({ length: pageCount }, (_, page) => paginateGateRows(rows, page).rows).flat()

    expect(paged.map((row) => row.gate)).toEqual(rows.map((row) => row.gate))
  })
})
