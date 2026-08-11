/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import type { JSX } from "solid-js"
import { ThoughtPanel } from "../src/component/thought-panel"

const ROOT = path.join(import.meta.dir, "..")

const THEME = { border: RGBA.fromInts(60, 60, 60, 255), text: RGBA.fromInts(230, 230, 230, 255), textMuted: RGBA.fromInts(140, 140, 140, 255) }

async function frame(node: () => JSX.Element) {
  const app = await testRender(node, { width: 80, height: 16 })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

describe("the panel is rendered by the route, not through a plugin", () => {
  // The slot machinery existed to keep upstream files untouched, and that rule
  // was justified by a merge cost this fork does not pay: it owns its UI and
  // does not carry upstream's UI changes. A plugin per piece of UI bought
  // distance between the rendering and its only caller, and nothing else.
  test("the route renders the panel directly", () => {
    const source = readFileSync(path.join(ROOT, "src/routes/session/index.tsx"), "utf8")
    expect(source).toContain("<ThoughtPanel")
    expect(source).not.toContain("session_reasoning")
  })
})

describe("the header answers whether to open the block", () => {
  test("it states what the thought was about, not only how long it took", async () => {
    const painted = await frame(() => (
      <ThoughtPanel theme={THEME} text="The front door is decided by one line. Then the rest." duration="14.1s" done />
    ))
    expect(painted).toContain("Thought")
    expect(painted).toContain("14.1s")
    expect(painted).toContain("The front door is decided by one line.")
  })

  test("a provider that emits a bolded title has it used verbatim", async () => {
    const painted = await frame(() => (
      <ThoughtPanel theme={THEME} text="body" title="Inspecting the route default" duration="2.0s" done />
    ))
    expect(painted).toContain("Inspecting the route default")
  })

  test("collapsed is the default, and the control says which way it goes", async () => {
    // The heading IS the first clause, so it is painted while collapsed by
    // design — what must not be painted is the rest of the deliberation.
    const painted = await frame(() => (
      <ThoughtPanel theme={THEME} text="First clause. The private deliberation nobody asked to read." done />
    ))
    expect(painted).toContain("expand")
    expect(painted).toContain("First clause.")
    expect(painted).not.toContain("nobody asked to read")
  })

  test("an unfinished thought still says something", async () => {
    // No duration and no text yet — the header must not render an empty label
    // that reads as a fault.
    const painted = await frame(() => <ThoughtPanel theme={THEME} text="" done={false} />)
    expect(painted).toContain("thinking")
  })
})
