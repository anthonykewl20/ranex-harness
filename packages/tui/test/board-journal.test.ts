import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { testRender } from "@opentui/solid"
import {
  JOURNAL_PAGE_SIZE,
  JournalPane,
  JournalTable,
  formatJournalDigest,
  paginateJournalEntries,
  type JournalData,
  type JournalEntry,
} from "../src/feature-plugins/board/panes/journal"
import { PANES } from "../src/feature-plugins/board/panes"
import { createTuiPluginApi } from "./fixture/tui-plugin"

const ROOT = path.join(import.meta.dir, "..")
const SOURCE = readFileSync(path.join(ROOT, "src/feature-plugins/board/panes/journal.tsx"), "utf8")

async function capture(render: () => ReturnType<typeof JournalPane.render>, height = 24) {
  const app = await testRender(render, { width: 120, height })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    sequence: 1841,
    kind: "gate.evaluated",
    digest: "a3f9c2e1",
    previousDigest: "7be4c1d0",
    subjectDigest: "subject-current",
    ...overrides,
  }
}

type ReadJournalData = Extract<JournalData, { state: "read" }>

function journal(overrides: Partial<Omit<ReadJournalData, "state">> = {}): ReadJournalData {
  return {
    state: "read",
    subjectDigest: "subject-current",
    evaluationDigest: "evaluation-a3f9c2e1",
    entries: [entry()],
    verification: { state: "unverified" },
    ...overrides,
  }
}

describe("the journal pane", () => {
  test("registers the reserved identity and order", () => {
    expect(JournalPane).toMatchObject({ id: "ranex.board.journal", title: "Journal", order: 600 })
    expect(PANES).toContain(JournalPane)
  })

  test("renders the missing read channel as UNVERIFIED, never verified", async () => {
    const frame = await capture(() =>
      JournalPane.render({
        api: createTuiPluginApi(),
        data: { state: "unread", why: "the return channel does not exist" },
      }),
    )

    expect(frame).toContain("STATUS: UNVERIFIED")
    expect(frame).not.toContain("STATUS: VERIFIED")
    expect(frame).toContain("Absence blocks")
    expect(frame).toContain("No journal entries were read")
    expect(frame).toContain("the return channel does not exist")
  })

  test("renders unverified and verified as visually distinct spelled states", async () => {
    const unverified = await capture(() =>
      JournalTable({ api: createTuiPluginApi(), data: journal(), page: 0 }),
    )
    const verified = await capture(() =>
      JournalTable({
        api: createTuiPluginApi(),
        data: journal({ verification: { state: "verified", entryCount: 1841 } }),
        page: 0,
      }),
    )

    expect(unverified).not.toBe(verified)
    expect(unverified).toContain("STATUS: UNVERIFIED")
    expect(unverified).not.toContain("STATUS: VERIFIED")
    expect(verified).toContain("STATUS: VERIFIED")
    expect(verified).not.toContain("STATUS: UNVERIFIED")
    expect(verified).toContain("confirmed 1841 entries")
  })

  test("makes a broken chain unmissable and names its breaking sequence", async () => {
    const sequence = 1839
    const frame = await capture(() =>
      JournalTable({
        api: createTuiPluginApi(),
        data: journal({ verification: { state: "broken", sequence } }),
        page: 0,
      }),
    )

    expect(frame).toContain("STATUS: CHAIN BROKEN")
    expect(frame).toContain(`Break at sequence ${sequence}`)
    expect(frame).toContain("DO NOT TRUST later entries")
    expect(frame).not.toContain("STATUS: VERIFIED")
  })

  test("renders an unreadable journal as an operational refusal, not a verdict", async () => {
    const frame = await capture(() =>
      JournalTable({
        api: createTuiPluginApi(),
        data: { state: "unavailable", reason: "unreadable", detail: "permission denied" },
        page: 0,
      }),
    )

    expect(frame).toContain("JOURNAL OPERATIONAL REFUSAL")
    expect(frame).toContain("journal unreadable — permission denied")
    expect(frame).not.toContain("STATUS:")
    expect(frame).not.toContain("PASS")
    expect(frame).not.toContain("FAIL")
  })

  test("renders a locked journal as its own operational refusal", async () => {
    const unreadable = await capture(() =>
      JournalTable({
        api: createTuiPluginApi(),
        data: { state: "unavailable", reason: "unreadable", detail: "permission denied" },
        page: 0,
      }),
    )
    const locked = await capture(() =>
      JournalTable({
        api: createTuiPluginApi(),
        data: { state: "unavailable", reason: "locked", detail: "held by verifier 42" },
        page: 0,
      }),
    )

    expect(locked).toContain("JOURNAL OPERATIONAL REFUSAL")
    expect(locked).toContain("journal locked — held by verifier 42")
    expect(locked).not.toBe(unreadable)
  })

  test("shows verification progress without implying a verified chain", async () => {
    const checked = JOURNAL_PAGE_SIZE * 4
    const total = checked * 5
    const frame = await capture(() =>
      JournalTable({
        api: createTuiPluginApi(),
        data: journal({ verification: { state: "verifying", checked, total } }),
        page: 0,
      }),
    )

    expect(frame).toContain("STATUS: VERIFYING")
    expect(frame).toContain(`${checked} of ${total} entries checked`)
    expect(frame).not.toContain("STATUS: VERIFIED")
  })

  test("filters other subjects and shows the active filter", async () => {
    const current = [
      entry({ sequence: 3, kind: "current-three" }),
      entry({ sequence: 2, kind: "current-two" }),
    ]
    const frame = await capture(() =>
      JournalTable({
        api: createTuiPluginApi(),
        data: journal({
          entries: [...current, entry({ sequence: 1, kind: "other-one", subjectDigest: "subject-other" })],
        }),
        page: 0,
      }),
    )

    expect(frame).toContain("FILTER: subject subject-current")
    expect(frame).toContain(`${current.length} shown`)
    expect(frame).toContain("1 other-subject entry hidden")
    for (const row of current) expect(frame).toContain(row.kind)
    expect(frame).not.toContain("other-one")
  })

  test("renders sequence, kind, digest, previous digest, and evaluation digest", async () => {
    const row = entry({
      digest: "digest-that-is-longer-than-the-column",
      previousDigest: "previous-digest-that-is-longer-than-the-column",
    })
    const evaluationDigest = "evaluation-record-digest"
    const frame = await capture(() =>
      JournalTable({
        api: createTuiPluginApi(),
        data: journal({ entries: [row], evaluationDigest }),
        page: 0,
      }),
    )

    expect(frame).toContain("SEQUENCE")
    expect(frame).toContain("KIND")
    expect(frame).toContain("DIGEST")
    expect(frame).toContain("PREVIOUS DIGEST")
    expect(frame).toContain(String(row.sequence))
    expect(frame).toContain(row.kind)
    expect(frame).toContain(formatJournalDigest(row.digest))
    expect(frame).toContain(formatJournalDigest(row.previousDigest))
    expect(frame).toContain(`evaluation record digest ${evaluationDigest}`)
  })

  test("paginates long subject lists while preserving their input order", () => {
    const total = JOURNAL_PAGE_SIZE * 3
    const kind = (index: number) => `journal-${String(index).padStart(4, "0")}`
    const rows = Array.from({ length: total }, (_, index) =>
      entry({ sequence: total - index, kind: kind(index) }),
    )
    const pageCount = paginateJournalEntries(rows, "subject-current", 0).pageCount
    const paged = Array.from(
      { length: pageCount },
      (_, page) => paginateJournalEntries(rows, "subject-current", page).rows,
    ).flat()

    expect(pageCount).toBe(total / JOURNAL_PAGE_SIZE)
    expect(paged.map((row) => row.kind)).toEqual(rows.map((row) => row.kind))
  })

  test("renders every row of a page and its pager inside an ordinary terminal", async () => {
    const total = JOURNAL_PAGE_SIZE * 3
    const kind = (index: number) => `journal-${String(index).padStart(4, "0")}`
    const rows = Array.from({ length: total }, (_, index) =>
      entry({ sequence: total - index, kind: kind(index) }),
    )
    const frame = await capture(
      () =>
        JournalTable({
          api: createTuiPluginApi(),
          data: journal({ entries: rows }),
          page: 0,
        }),
      24,
    )

    for (let index = 0; index < JOURNAL_PAGE_SIZE; index += 1) {
      expect(frame).toContain(kind(index))
    }
    expect(frame).not.toContain(kind(JOURNAL_PAGE_SIZE))
    expect(frame).toContain(`page 1 of ${total / JOURNAL_PAGE_SIZE}`)
    expect(frame.indexOf("page 1")).toBeLessThan(frame.indexOf(kind(0)))
  })

  test("is source-level read-only with no journal write path", () => {
    expect(SOURCE).not.toMatch(/\b(?:appendFile|appendFileSync|writeFile|writeFileSync|createWriteStream)\b/)
    expect(SOURCE).not.toMatch(/\bBun\.write\b/)
    expect(SOURCE).not.toMatch(/\.\s*(?:append|write)\s*\(/)
    expect(SOURCE).not.toMatch(/ranex\s+journal\s+(?:append|add|write|record)\b/)
    expect(SOURCE).not.toMatch(/props\.api\.(?:client|event)\b/)
    expect(SOURCE).toContain("READ ONLY")
  })
})
