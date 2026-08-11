import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { assertEntries, resolveEntry, type AnyTranscriptEntry, type TranscriptItem } from "../src/feature-plugins/transcript/entry"
import { ENTRIES } from "../src/feature-plugins/transcript/entries"

const ROOT = path.join(import.meta.dir, "..")

const entry = (over: Partial<AnyTranscriptEntry> = {}) =>
  ({
    id: "ranex.transcript.user",
    kind: "user",
    order: 100,
    render: () => null,
    ...over,
  }) as AnyTranscriptEntry

/**
 * CHAT-02 — the entry seam.
 *
 * CHAT-03..09 are six entries built concurrently in six worktrees. These are the
 * collisions that survive a clean merge: git happily takes both sides of an
 * array append, so a duplicate order, id or kind arrives with no conflict marker
 * and then reorders — or shadows — the transcript for reasons nobody can see.
 */
describe("CHAT-02: the entry registry rejects merge artefacts at construction", () => {
  test("a duplicate order throws and names both entries", () => {
    expect(() =>
      assertEntries([entry(), entry({ id: "ranex.transcript.assistant", kind: "assistant" })]),
    ).toThrow(/collides with ranex\.transcript\.user on .*order 100/)
  })

  test("a duplicate id throws", () => {
    expect(() => assertEntries([entry(), entry({ kind: "assistant", order: 200 })])).toThrow(/id ranex\.transcript\.user/)
  })

  // Two entries claiming one kind is the subtler artefact: nothing reorders, but
  // the second is unreachable, so a whole item kind silently stops rendering.
  test("a duplicate kind throws, because the second would never render", () => {
    expect(() => assertEntries([entry(), entry({ id: "ranex.transcript.other", order: 200 })])).toThrow(/kind user/)
  })

  test("a well-formed registry is returned sorted by order, not array position", () => {
    const sorted = assertEntries([
      entry({ id: "ranex.transcript.tool", kind: "tool", order: 400 }),
      entry(),
    ])
    expect(sorted.map((e) => e.order)).toEqual([100, 400])
  })
})

describe("CHAT-02: resolution is honest about what it cannot render", () => {
  const item: TranscriptItem = { kind: "error", id: "e1", why: "provider aborted" }

  test("an item no entry claims resolves to undefined, so the chrome can say so", () => {
    // Never a nearest-match fallback. An item rendered as the wrong kind is
    // worse than one rendered as `unrendered`, because it looks correct.
    expect(resolveEntry([entry()], item)).toBeUndefined()
  })

  test("an item an entry claims resolves to that entry", () => {
    const error = entry({ id: "ranex.transcript.error", kind: "error", order: 600 })
    expect(resolveEntry([entry(), error], item)?.id).toBe("ranex.transcript.error")
  })
})

describe("CHAT-02: the seam stays two edits", () => {
  test("the shipped registry is well-formed", () => {
    expect(() => assertEntries(ENTRIES)).not.toThrow()
  })

  test("the registry imports entries only through this directory's index", () => {
    // If the chrome ever imports an entry directly, adding one stops being two
    // edits and every concurrent entry starts conflicting on that file.
    const source = readFileSync(path.join(ROOT, "src/feature-plugins/transcript/entries/index.ts"), "utf8")
    expect(source).not.toMatch(/^import .*from "\.\.\/entries\//m)
  })
})
