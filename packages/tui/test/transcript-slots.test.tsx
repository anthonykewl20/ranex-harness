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

  // The count is deliberately NOT capped. UI is owned rather than merged —
  // upstream's UI changes are not carried forward — so a slot costs a line, not
  // a recurring merge, and an earlier revision that capped this at two was
  // protecting against a cost this fork does not pay.
  //
  // What still matters is that every slot rendered is declared, so a typo'd name
  // silently renders nothing forever.
  test("every slot the session route renders is declared in the host map", () => {
    const rendered = [...readFileSync(SESSION, "utf8").matchAll(/name="(session_[a-z_]+)"/g)].map((m) => m[1])
    const map = readFileSync(SLOT_MAP, "utf8")
    expect(rendered.length).toBeGreaterThanOrEqual(2)
    for (const name of new Set(rendered)) expect(map).toContain(`${name}: {`)
  })

  // Regression. The first revision wrapped the <scrollbox> itself, so filling
  // the slot with `replace` removed it — and with it scroll position, sticky
  // scroll, acceleration and the `scroll` ref driving every navigation command.
  // Nothing failed: the transcript rendered, and long conversations simply could
  // not be scrolled. The seam must sit INSIDE the scrollbox, because scrolling
  // is live behaviour the route owns and only the message list is rendering.
  test("the transcript slot is inside the scrollbox, not wrapped around it", () => {
    const source = readFileSync(SESSION, "utf8")
    const scrollbox = source.indexOf("<scrollbox")
    const slot = source.indexOf('name="session_transcript"')
    const closeScrollbox = source.indexOf("</scrollbox>")
    expect(scrollbox).toBeGreaterThanOrEqual(0)
    expect(slot).toBeGreaterThan(scrollbox)
    expect(slot).toBeLessThan(closeScrollbox)
  })

  test("both new slots are declared in the host slot map", () => {
    const map = readFileSync(SLOT_MAP, "utf8")
    for (const name of ["session_transcript", "session_blocker"]) {
      expect(map).toContain(`${name}: {`)
    }
  })
})
