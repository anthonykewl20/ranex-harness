import { describe, expect, test } from "bun:test"
import { fitStatus, statusLabel } from "../src/feature-plugins/transcript/status"

describe("CHAT-12: the live state is spelled", () => {
  // claude-code #70000 — a screen reader told nothing about generating or
  // complete, because the only signal was a spinner. Words are the state.
  test("each status has a word", () => {
    expect(statusLabel({ type: "busy" })).toBe("responding")
    expect(statusLabel({ type: "idle" })).toBe("idle")
    expect(statusLabel(undefined)).toBe("idle")
  })

  // A retried turn is not a normally-running one. Collapsing them is how a
  // silent provider fallback goes unnoticed (ux-research.md §3).
  test("retry is its own state and carries the attempt an operator acts on", () => {
    expect(statusLabel({ type: "retry", attempt: 3, message: "rate limited", next: 0 })).toBe("retrying (3)")
  })
})

describe("CHAT-12: the row degrades by priority and never overlaps", () => {
  const fields = ["a-very-long-session-title", "ranex-trim", "responding"]

  test("everything fits when there is room", () => {
    expect(fitStatus(fields, 100)).toBe("a-very-long-session-title  ranex-trim  responding")
  })

  test("under pressure the live state is the last field standing", () => {
    // It is the only field answering "is anything happening right now", so it
    // survives every other field being dropped.
    expect(fitStatus(fields, 20)).toBe("responding")
  })

  test("a row narrower than any field renders empty rather than overflowing", () => {
    expect(fitStatus(fields, 3)).toBe("")
  })

  test("output never exceeds the width it was given", () => {
    for (let width = 0; width < 60; width++) {
      expect(fitStatus(fields, width).length).toBeLessThanOrEqual(width)
    }
  })
})
