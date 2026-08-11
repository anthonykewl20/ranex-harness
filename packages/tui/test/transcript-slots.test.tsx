/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createSlot, createSolidSlotRegistry, testRender, useRenderer } from "@opentui/solid"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.join(import.meta.dir, "..")
const SESSION = path.join(ROOT, "src/routes/session/index.tsx")
const SLOT_MAP = path.join(ROOT, "../plugin/src/tui.ts")

/**
 * CHAT-01 / ADR-022 — the transcript seam.
 *
 * Two properties are asserted here, and the first is the one the whole design
 * rests on: **an unfilled slot must render what the route renders today.** If
 * that fails, a plugin that fails to load blanks the operator's screen instead
 * of falling back, and the seam is a liability rather than a seam.
 */
describe("CHAT-01: the transcript slots", () => {
  type Slots = { session_transcript: {}; session_blocker: {} }

  test("an unfilled slot renders its children, so upstream shows through", async () => {
    // No registry.register() call — this is the plugin-failed-to-load case.
    const App = () => {
      const registry = createSolidSlotRegistry<Slots>(useRenderer(), {})
      const Slot = createSlot(registry)
      return (
        <Slot name="session_transcript" mode="replace">
          <text>upstream transcript</text>
        </Slot>
      )
    }

    const app = await testRender(() => <App />, { width: 40, height: 6 })
    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("upstream transcript")
    } finally {
      app.renderer.destroy()
    }
  })

  test("a filled slot replaces the upstream rendering", async () => {
    const App = () => {
      const registry = createSolidSlotRegistry<Slots>(useRenderer(), {})
      const Slot = createSlot(registry)
      registry.register({
        id: "ranex.transcript",
        slots: { session_transcript: () => <text>ranex transcript</text> },
      })
      return (
        <Slot name="session_transcript" mode="replace">
          <text>upstream transcript</text>
        </Slot>
      )
    }

    const app = await testRender(() => <App />, { width: 40, height: 6 })
    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("ranex transcript")
      expect(frame).not.toContain("upstream transcript")
    } finally {
      app.renderer.destroy()
    }
  })

  // ADR-022 bounds the amendment to ADR-018's "untouched beyond imports" rule at
  // exactly two new slots. A third arriving without a successor ADR is the way
  // this decision erodes, so the bound is a test rather than a sentence.
  test("the session route carries exactly the declared slots and no more", () => {
    const source = readFileSync(SESSION, "utf8")
    const rendered = [...source.matchAll(/name="(session_[a-z_]+)"/g)].map((m) => m[1]).sort()
    expect(rendered).toEqual(["session_blocker", "session_prompt", "session_prompt_right", "session_transcript"])
  })

  test("both new slots are declared in the host slot map", () => {
    const map = readFileSync(SLOT_MAP, "utf8")
    for (const name of ["session_transcript", "session_blocker"]) {
      expect(map).toContain(`${name}: {`)
    }
  })
})
