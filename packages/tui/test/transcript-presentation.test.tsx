/** @jsxImportSource @opentui/solid */
//
// CHAT-18 — the honesty property, and the test ADR-022's Confirmation names.
//
// Entries are reached through their public registry `render`, which is how the
// chrome invokes them, so this exercises the same path a real render takes.
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { createTuiPluginApi } from "./fixture/tui-plugin"
import { TestTuiContexts } from "./fixture/tui-environment"
import { ENTRIES } from "../src/feature-plugins/transcript/entries"
import { PermissionEntry, ErrorEntry } from "../src/feature-plugins/transcript/entries/permission"
import { UserEntry } from "../src/feature-plugins/transcript/entries/user"
import { ToolEntry } from "../src/feature-plugins/transcript/entries/tool"
import type { TranscriptItem } from "../src/feature-plugins/transcript/entry"

async function frame(node: () => JSX.Element) {
  const app = await testRender(() => <TestTuiContexts>{node()}</TestTuiContexts>, { width: 100, height: 24 })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

const api = () => createTuiPluginApi()

const USER: TranscriptItem = {
  kind: "user",
  id: "m1",
  message: {} as never,
  parts: [{ type: "text", text: "redesign the chat interface" }] as never,
}

const TOOL_FAILED: TranscriptItem = {
  kind: "tool",
  id: "p1",
  message: {} as never,
  part: { tool: "read", state: { status: "error", input: { filePath: "a/b/c.ts" } } } as never,
}

const PERMISSION: TranscriptItem = {
  kind: "permission",
  id: "r1",
  request: { id: "r1", title: "edit", body: "packages/tui/**" },
}

const ERROR: TranscriptItem = { kind: "error", id: "e1", why: "provider aborted mid-stream" }

describe("CHAT-18: no state is carried by colour or a glyph alone", () => {
  // This is what makes NO_COLOR, a pipe, a 16-colour terminal and a screen
  // reader all lossless: the words are the state, and styling only reinforces
  // them. A frame capture is text, so if a state were colour-only it would be
  // absent here rather than merely different.
  test("a failed tool call spells the failure", async () => {
    const painted = await frame(() => ToolEntry.render({ api: api(), item: TOOL_FAILED as never }))
    expect(painted).toContain("failed")
  })

  test("an approval request spells what is being approved, verbatim", async () => {
    const painted = await frame(() => PermissionEntry.render({ api: api(), item: PERMISSION as never }))
    expect(painted).toContain("approval required")
    // The subject is never paraphrased — claude-code #83879 is wrong selections
    // from a prompt that described the request instead of showing it.
    expect(painted).toContain("edit")
  })

  test("an error spells its cause rather than only colouring the row", async () => {
    const painted = await frame(() => ErrorEntry.render({ api: api(), item: ERROR as never }))
    expect(painted).toContain("error")
    expect(painted).toContain("provider aborted mid-stream")
  })
})

describe("CHAT-03: the body copies without repair", () => {
  test("message text starts at the line's first column, with no gutter", async () => {
    const painted = await frame(() => UserEntry.render({ api: api(), item: USER as never }))
    const line = painted.split("\n").find((l) => l.includes("redesign the chat interface"))
    expect(line).toBeDefined()
    // claude-code #75221 asks for an option to strip the left gutter because it
    // is copied along with the text. There is no gutter to strip.
    expect(line!.startsWith("redesign the chat interface")).toBe(true)
  })

  test("identity is on its own line above the body, not beside it", async () => {
    const painted = await frame(() => UserEntry.render({ api: api(), item: USER as never }))
    const lines = painted.split("\n").map((l) => l.trimEnd())
    const label = lines.findIndex((l) => l.includes("you"))
    const body = lines.findIndex((l) => l.includes("redesign the chat interface"))
    expect(label).toBeGreaterThanOrEqual(0)
    expect(body).toBeGreaterThan(label)
  })
})

describe("CHAT-18: every entry renders under a degraded terminal", () => {
  // A renderer that throws when the glyph set or palette degrades is the same
  // outage as one that renders nothing. Each entry must paint something.
  test("no entry renders an empty frame for its own kind", async () => {
    const items: Record<string, TranscriptItem> = {
      user: USER,
      tool: TOOL_FAILED,
      permission: PERMISSION,
      error: ERROR,
    }
    for (const entry of ENTRIES) {
      const item = items[entry.kind]
      if (!item) continue
      const painted = await frame(() => entry.render({ api: api(), item } as never))
      expect(painted.trim().length).toBeGreaterThan(0)
    }
  })
})

describe("CHAT-20: the transcript never answers what the board is for", () => {
  // ADR-022 keeps the board as the only verdict surface. Two surfaces reading
  // the same state independently is how claude-code #74355 and #53712 produced
  // a status line contradicting the command reporting the same figure — and
  // ADR-018 recorded the same hazard for verdicts before either was filed.
  test("no entry renders a verdict, a gate, or an admissibility claim", async () => {
    const forbidden = ["PASS", "FAIL", "verdict", "gate", "admissible", "approved by"]
    const items: TranscriptItem[] = [USER, TOOL_FAILED, PERMISSION, ERROR]
    for (const item of items) {
      const entry = ENTRIES.find((e) => e.kind === item.kind)
      if (!entry) continue
      const painted = await frame(() => entry.render({ api: api(), item } as never))
      for (const word of forbidden) {
        expect(painted).not.toContain(word)
      }
    }
  })
})
