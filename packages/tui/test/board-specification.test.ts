import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import {
  SPECIFICATION_APPROVED,
  SPECIFICATION_NOT_YET_SPECIFIED,
  SPECIFICATION_ROW_LABELS,
  SPECIFICATION_SELF_APPROVAL,
  SPECIFICATION_SUITE_MISMATCH,
  SPECIFICATION_UNPROVEN,
  SpecificationDetails,
  SpecificationPane,
  type SpecificationPresentation,
} from "../src/feature-plugins/board/panes/specification"
import { createTuiPluginApi } from "./fixture/tui-plugin"

const APPROVER = "owner"
const PRODUCER = "agent-014"
const BASE_PRESENTATION = {
  approval: "approved",
  identity: { state: "known", approver: APPROVER, producer: PRODUCER },
  suite: "matches",
  redThenGreen: "observed",
} satisfies SpecificationPresentation

async function capture(render: () => ReturnType<typeof SpecificationPane.render>, height = 24) {
  const app = await testRender(render, { width: 120, height })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

function presentation(overrides: Partial<SpecificationPresentation> = {}): SpecificationPresentation {
  return { ...BASE_PRESENTATION, ...overrides }
}

function row(frame: string, label: (typeof SPECIFICATION_ROW_LABELS)[number]) {
  return frame.split("\n").find((line) => line.trimStart().startsWith(label))
}

describe("the specification pane", () => {
  test("registers the reserved identity and order", () => {
    expect(SpecificationPane).toMatchObject({
      id: "ranex.board.specification",
      title: "Specification",
      order: 300,
    })
  })

  test("renders unread as unavailable and every contract field as not yet specified", async () => {
    const reason = "the specification return channel does not exist"
    const frame = await capture(() =>
      SpecificationPane.render({
        api: createTuiPluginApi(),
        data: { state: "unread", why: reason },
      }),
    )

    expect(frame).toContain("Specification unavailable")
    expect(frame).toContain("No specification approval was read")
    expect(frame).toContain(reason)

    for (const label of SPECIFICATION_ROW_LABELS.filter((item) => item !== "pane capability")) {
      const rendered = row(frame, label)
      expect(rendered).toBeDefined()
      expect(rendered).toContain(SPECIFICATION_NOT_YET_SPECIFIED)
      expect(rendered).not.toMatch(/\s0\s*$/)
    }
  })

  test("renders no approval as explicit blocking absence", async () => {
    const frame = await capture(() =>
      SpecificationDetails({
        api: createTuiPluginApi(),
        presentation: presentation({ approval: "missing" }),
      }),
    )

    expect(row(frame, "C ApprovalEnvelope")).toContain("NO APPROVAL EXISTS")
    expect(row(frame, "C ApprovalEnvelope")).toContain("absence blocks")
    expect(row(frame, "C ApprovalEnvelope")).not.toContain(SPECIFICATION_APPROVED)
  })

  test("never renders expired or revoked envelopes as approved", async () => {
    for (const approval of ["expired", "revoked"] as const) {
      const frame = await capture(() =>
        SpecificationDetails({
          api: createTuiPluginApi(),
          presentation: presentation({ approval }),
        }),
      )

      expect(row(frame, "C ApprovalEnvelope")).toContain(approval.toUpperCase())
      expect(row(frame, "C ApprovalEnvelope")).not.toContain(SPECIFICATION_APPROVED)
      expect(row(frame, "expiry / revocation")).not.toContain(SPECIFICATION_APPROVED)
    }
  })

  test("renders an unobserved red-then-green transition as unproven, never passed", async () => {
    const frame = await capture(() =>
      SpecificationDetails({
        api: createTuiPluginApi(),
        presentation: presentation({ redThenGreen: "unproven" }),
      }),
    )
    const rendered = row(frame, "red then green")

    expect(rendered).toContain(SPECIFICATION_UNPROVEN)
    expect(rendered).toContain("was not observed")
    expect(rendered).not.toMatch(/\bPASS(?:ED)?\b/)
  })

  test("flags an approver who is also the producer", async () => {
    const frame = await capture(() =>
      SpecificationDetails({
        api: createTuiPluginApi(),
        presentation: presentation({
          identity: { state: "known", approver: PRODUCER, producer: PRODUCER },
        }),
      }),
    )
    const rendered = row(frame, "self-approval check")

    expect(rendered).toContain(SPECIFICATION_SELF_APPROVAL)
    expect(rendered).toContain("approver equals producer")
    expect(rendered).toContain("blocks")
  })

  test("renders a suite manifest mismatch as not judged against the frozen suite", async () => {
    const frame = await capture(() =>
      SpecificationDetails({
        api: createTuiPluginApi(),
        presentation: presentation({ suite: "mismatch" }),
      }),
    )
    const rendered = row(frame, "running suite")

    expect(rendered).toContain(SPECIFICATION_SUITE_MISMATCH)
    expect(rendered).toContain("not judged against frozen suite")
    expect(rendered).not.toMatch(/\sMATCH —/)
  })

  test("renders every claimed row inside an ordinary captured frame", async () => {
    const frame = await capture(() =>
      SpecificationDetails({
        api: createTuiPluginApi(),
        presentation: presentation({
          approval: "revoked",
          identity: { state: "known", approver: PRODUCER, producer: PRODUCER },
          suite: "mismatch",
          redThenGreen: "unproven",
        }),
      }),
    )

    for (const label of SPECIFICATION_ROW_LABELS) expect(row(frame, label)).toBeDefined()
  })

  test("states that the pane cannot approve or hold a key", async () => {
    const frame = await capture(() =>
      SpecificationDetails({ api: createTuiPluginApi(), presentation: BASE_PRESENTATION }),
    )

    expect(row(frame, "pane capability")).toContain("READ-ONLY")
    expect(row(frame, "pane capability")).toContain("approves nothing and holds no key")
  })
})
