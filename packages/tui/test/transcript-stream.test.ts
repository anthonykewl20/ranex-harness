import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.join(import.meta.dir, "..")

describe("CHAT-13: nothing in the terminal chrome animates", () => {
  // claude-code #17887 — a spinner in the terminal title makes the tab width
  // change on every frame, forever. The fix is not to animate chrome at all, so
  // the check is that the title is only ever set from route and session state.
  test("the terminal title is set from state, never from a spinner or a frame counter", () => {
    const source = readFileSync(path.join(ROOT, "src/app.tsx"), "utf8")
    const calls = [...source.matchAll(/setTerminalTitle\(([^)]*)\)/g)].map((m) => m[1] ?? "")
    expect(calls.length).toBeGreaterThan(0)
    for (const argument of calls) {
      expect(argument).not.toMatch(/spinner|frame|tick|Date\.now|interval/i)
    }
  })

  test("no interval or timer drives the title", () => {
    const source = readFileSync(path.join(ROOT, "src/app.tsx"), "utf8")
    // A title inside a timer is the same defect wearing a different hat.
    const timers = [...source.matchAll(/setInterval\([\s\S]{0,400}?\)/g)].map((m) => m[0])
    for (const timer of timers) expect(timer).not.toContain("setTerminalTitle")
  })
})

describe("CHAT-13: streaming identity is not a renderer concern", () => {
  // Recorded rather than tested, because there is nothing here to test.
  //
  // ADR-022's sad path 4 originally promised idempotent append "on chunk id".
  // There is no chunk id: `context/sync.tsx` applies `message.part.delta` by
  // concatenating onto `partID` + `field`, and `partID` names the part, not the
  // delta. A duplicate delivery therefore duplicates content, and no renderer
  // downstream can detect it — the same text arriving twice is indistinguishable
  // from the model emitting it twice.
  //
  // A fix belongs in the protocol or the sync layer, above the TUI. This test
  // pins the fact so the claim cannot quietly reappear in a design document.
  test("the sync layer carries no delta identity to be idempotent on", () => {
    const source = readFileSync(path.join(ROOT, "src/context/sync.tsx"), "utf8")
    expect(source).toContain("message.part.delta")
    expect(source).not.toMatch(/chunkId|chunk_id|deltaId|delta_id|sequence/i)
  })
})
