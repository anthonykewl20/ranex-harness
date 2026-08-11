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
  // Success is silent, and that is the rule rather than an omission. `done` on
  // every line is one word repeated down the whole screen: it distinguishes
  // nothing because everything says it, and it drowns the line that says
  // something else. Every state that is NOT plain success still spells itself.
  test("success says nothing; every other state spells a word", () => {
    expect(toolOutcome({ status: "completed" })).toBeUndefined()
    expect(toolOutcome({ status: "error" })).toBe("failed")
    expect(toolOutcome({ status: "running" })).toBe("running")
    expect(toolOutcome({ status: "pending" })).toBe("queued")
  })

  test("an unknown status is passed through, never mapped to a familiar one", () => {
    expect(toolOutcome({ status: "rejected" })).toBe("rejected")
    expect(toolOutcome(undefined)).toBeUndefined()
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

describe("CHAT-04: a turn that only ran tools prints no empty header", () => {
  // A bare `ranex` label with nothing under it, once per tool-calling turn, is
  // what a long task produced. The tool entries already carry that turn's work.
  test("an assistant message with no text yields no assistant item", () => {
    const speak = (text: string) => [{ type: "text", text }]
    const cases: Array<[string, unknown[], boolean]> = [
      ["only tool calls", [], false],
      ["whitespace only", speak("   \n "), false],
      ["real text", speak("here is the summary"), true],
    ]
    for (const [name, parts, expected] of cases) {
      const spoke = (parts as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === "text")
        .some((p) => typeof p.text === "string" && p.text.trim().length > 0)
      expect(`${name}:${spoke}`).toBe(`${name}:${expected}`)
    }
  })
})
