import { describe, expect, test } from "bun:test"
import type { TuiPluginApi } from "@ranex/plugin/tui"
import { DENSITIES, cycleDensity, isDensity, readDensity, shows, startsOpen } from "../src/feature-plugins/transcript/density"
import { diffStat } from "../src/feature-plugins/transcript/entries/tool"

const fakeApi = (initial?: unknown) => {
  const store = new Map<string, unknown>()
  if (initial !== undefined) store.set("transcript_density", initial)
  return {
    kv: {
      get: (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback),
      set: (key: string, value: unknown) => void store.set(key, value),
    },
  } as unknown as TuiPluginApi
}

describe("CHAT-16: density", () => {
  test("defaults to normal", () => {
    expect(readDensity(fakeApi())).toBe("normal")
  })

  // claude-code #56423's complaint is that the choice does not survive, not only
  // that the default is wrong. A preference that resets is one re-set forever.
  test("a stored choice is read back", () => {
    expect(readDensity(fakeApi("compact"))).toBe("compact")
  })

  test("a corrupt stored value falls back to normal rather than throwing", () => {
    expect(readDensity(fakeApi("enormous"))).toBe("normal")
    expect(isDensity("enormous")).toBe(false)
  })

  test("cycling walks the modes and persists each step", () => {
    const api = fakeApi()
    expect(cycleDensity(api)).toBe("full")
    expect(readDensity(api)).toBe("full")
    expect(cycleDensity(api)).toBe("compact")
    expect(cycleDensity(api)).toBe("normal")
  })

  // This is the governance rule, not a preference: a density that could hide an
  // approval request would turn a display setting into a decision the operator
  // never got to make.
  test("no density can hide a permission or an error", () => {
    for (const density of DENSITIES) {
      expect(shows(density, "permission")).toBe(true)
      expect(shows(density, "error")).toBe(true)
    }
  })

  test("compact hides reasoning, other modes do not", () => {
    expect(shows("compact", "reasoning")).toBe(false)
    expect(shows("normal", "reasoning")).toBe(true)
    expect(shows("full", "reasoning")).toBe(true)
  })

  test("only full expands collapsibles by default", () => {
    expect(startsOpen("full")).toBe(true)
    expect(startsOpen("normal")).toBe(false)
    expect(startsOpen("compact")).toBe(false)
  })
})

describe("CHAT-08: the collapsed line states the size of a change", () => {
  const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1,2 @@", "-old", "+new", "+extra"].join("\n")

  test("counts added and removed lines, ignoring the file headers", () => {
    // `---`/`+++` are headers, not changes. Counting them is the classic
    // off-by-two that makes every diff report +1 −1 too many.
    expect(diffStat(diff)).toBe("+2 −1")
  })

  test("no diff means no stat, so the outcome column falls back to status", () => {
    expect(diffStat(undefined)).toBeUndefined()
  })
})
