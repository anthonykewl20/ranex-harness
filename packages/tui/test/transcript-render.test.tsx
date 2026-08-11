/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { ENTRIES } from "../src/feature-plugins/transcript/entries"
import { reasoningLabel } from "../src/feature-plugins/transcript/entries/reasoning"
import { toolOutcome, toolSubject, truncateMiddle } from "../src/feature-plugins/transcript/entries/tool"
import { resolveEntry, type TranscriptItem } from "../src/feature-plugins/transcript/entry"

/**
 * CHAT-03..06 — the visible entries.
 *
 * These assert the rules the design record says distinguish this transcript from
 * the one it replaces, not that pixels appeared.
 */
describe("CHAT-06: a collapsed tool line carries the outcome", () => {
  // claude-code #57060 is a collapse toggle that leaves the reader no better
  // off. The outcome column is what makes the collapsed form sufficient.
  test("every status spells a word, never a colour or a blank", () => {
    expect(toolOutcome({ status: "completed" })).toBe("done")
    expect(toolOutcome({ status: "error" })).toBe("failed")
    expect(toolOutcome({ status: "running" })).toBe("running")
    expect(toolOutcome(undefined)).toBe("unknown")
  })

  test("an unknown status is passed through, never mapped to a familiar one", () => {
    expect(toolOutcome({ status: "rejected" })).toBe("rejected")
  })

  test("the subject truncates in the middle, because a path identifies by its tail", () => {
    const path = "packages/tui/src/feature-plugins/transcript/entries/assistant.tsx"
    const shown = truncateMiddle(path)
    expect(shown).toContain("…")
    expect(shown.endsWith("assistant.tsx")).toBe(true)
    expect(shown.length).toBeLessThanOrEqual(48)
  })

  test("the subject prefers the field that says what the call was about", () => {
    expect(toolSubject({ filePath: "a.ts" })).toBe("a.ts")
    expect(toolSubject({ command: "git status" })).toBe("git status")
    expect(toolSubject({})).toBe("")
  })
})

describe("CHAT-05: reasoning is labelled by content, for every provider", () => {
  // context/thinking.ts recovers a title only from OpenAI's `**Bold**\n\n`
  // convention; everything else degrades to a bare duration. Both shapes must
  // produce a usable label here, which is the whole point of the entry.
  test("an OpenAI-shaped summary uses its bolded title", () => {
    expect(reasoningLabel("**Inspecting the route default**\n\nThe front door…")).toBe("Inspecting the route default")
  })

  test("a provider that sends no title still gets a label, not a duration", () => {
    expect(reasoningLabel("The front door is decided by one line. Then the rest.")).toBe(
      "The front door is decided by one line.",
    )
  })

  test("empty reasoning says so rather than rendering a blank expandable region", () => {
    expect(reasoningLabel("   ")).toBe("no summary")
  })

  test("a long label is truncated at the tail, so the head stays readable", () => {
    // 56, not 72: a summary needing most of the width is not a summary, and a
    // label long enough to wrap stops being a label at all.
    const label = reasoningLabel("x".repeat(200))
    expect(label.length).toBeLessThanOrEqual(56)
    expect(label.endsWith("…")).toBe(true)
  })
})

describe("CHAT-02: the shipped registry", () => {
  test("every entry is registered in reserved order", () => {
    expect(ENTRIES.map((e) => `${e.order} ${e.kind}`)).toEqual([
      "100 user",
      "200 assistant",
      "300 reasoning",
      "400 tool",
      "500 permission",
      "600 error",
    ])
  })

  test("the closed item set is fully covered, so nothing renders as unrendered", () => {
    // `unrendered` is the honest fallback, not a resting state. Once every kind
    // has an entry, reaching it means a kind was added without a renderer.
    const kinds: TranscriptItem["kind"][] = ["user", "assistant", "reasoning", "tool", "permission", "error"]
    for (const kind of kinds) {
      expect(ENTRIES.some((e) => e.kind === kind)).toBe(true)
    }
  })

  test("an item kind outside the set still resolves to undefined, never a near match", () => {
    const item = { kind: "future", id: "x1" } as unknown as TranscriptItem
    expect(resolveEntry(ENTRIES, item)).toBeUndefined()
  })
})
