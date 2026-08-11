import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import {
  EVIDENCE_PAGE_SIZE,
  EVIDENCE_SUITE_OUTPUT_MAX_CHARACTERS,
  EVIDENCE_SUITE_OUTPUT_MAX_LINES,
  EvidencePane,
  EvidenceTable,
  paginateEvidenceRows,
  truncateEvidenceSuiteOutput,
  type EvidenceData,
  type EvidenceRecord,
} from "../src/feature-plugins/board/panes/evidence"
import { KNOWN_CAUSES } from "../src/feature-plugins/board/panes/gates"
import { PANES } from "../src/feature-plugins/board/panes"
import { createTuiPluginApi } from "./fixture/tui-plugin"

const CLAIM_ID = "tests-executed"
const SUBJECT_DIGEST = "sha256:15d70fd2"
const COMMAND_DIGEST = "sha256:7be4c1d0"
const PRODUCER = "agent-014"
const RECORD_PATH = ".ranex/evidence/record-0.json"

async function capture(render: () => ReturnType<typeof EvidencePane.render>, height = 24) {
  const app = await testRender(render, { width: 120, height })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

function record(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    claim_id: CLAIM_ID,
    subject_digest: SUBJECT_DIGEST,
    command_digest: COMMAND_DIGEST,
    producer: PRODUCER,
    suite_results_summary: "412 passed, 0 failed",
    record_path: RECORD_PATH,
    ...overrides,
  }
}

function evidence(overrides: Partial<EvidenceData> = {}): EvidenceData {
  return {
    verdict: "FAIL",
    subject_digest: SUBJECT_DIGEST,
    records: [record()],
    rejections: [],
    causes: [],
    ...overrides,
  }
}

async function capturePages(data: EvidenceData) {
  const pageCount = paginateEvidenceRows(data, 0).pageCount
  return Promise.all(
    Array.from({ length: pageCount }, (_, page) =>
      capture(() => EvidenceTable({ api: createTuiPluginApi(), data, page })),
    ),
  )
}

describe("the evidence pane", () => {
  test("registers the reserved identity and order", () => {
    expect(EvidencePane).toMatchObject({
      id: "ranex.board.evidence",
      title: "Evidence",
      order: 200,
    })
    expect(PANES).toContain(EvidencePane)
  })

  test("renders unread as unavailable, never as an empty evidence set", async () => {
    const why = "the evidence return channel does not exist"
    const frame = await capture(() =>
      EvidencePane.render({ api: createTuiPluginApi(), data: { state: "unread", why } }),
    )

    expect(frame).toContain("Evidence unavailable")
    expect(frame).toContain("No evidence or admission records were read")
    expect(frame).toContain(why)
    expect(frame).not.toContain("EVIDENCE PRESENT")
  })

  test("renders every admitted record field", async () => {
    const frame = await capture(() => EvidenceTable({ api: createTuiPluginApi(), data: evidence(), page: 0 }))

    for (const value of [CLAIM_ID, SUBJECT_DIGEST, COMMAND_DIGEST, PRODUCER, "412 passed, 0 failed"]) {
      expect(frame).toContain(value)
    }
    expect(frame).toContain("ADMITTED #0")
  })

  test("makes every authoritative cause reachable and textually distinct", async () => {
    const data = evidence({
      records: [],
      causes: KNOWN_CAUSES.map((cause) => ({ claim_id: `claim-${cause}`, cause })),
    })
    const frames = await capturePages(data)
    const rendered = frames.join("\n")
    const causeLines = KNOWN_CAUSES.map((cause) => rendered.split("\n").find((line) => line.includes(`claim-${cause}`)))

    expect(KNOWN_CAUSES).toHaveLength(7)
    for (const cause of KNOWN_CAUSES) expect(rendered).toContain(cause)
    expect(causeLines.every((line) => line !== undefined)).toBe(true)
    expect(new Set(causeLines).size).toBe(KNOWN_CAUSES.length)
    expect(rendered).not.toContain("unclassified")
  })

  test("renders a refused record even when the verdict is PASS", async () => {
    const rejection = {
      index: 4,
      reason: "signature-invalid",
      detail: "signature does not cover suite_results",
      claim_id: CLAIM_ID,
    }
    const frame = await capture(() =>
      EvidenceTable({
        api: createTuiPluginApi(),
        data: evidence({ verdict: "PASS", records: [], rejections: [rejection] }),
        page: 0,
      }),
    )

    expect(frame).toContain("VERDICT PASS")
    expect(frame).toContain(`REFUSED #${rejection.index}`)
    expect(frame).toContain(rejection.reason)
    expect(frame).toContain(rejection.detail)
    expect(frame).toContain(`claim ${rejection.claim_id}`)
    expect(frame).toContain("refused — record refused")
  })

  test("preserves a null claim as NO CLAIM and withholds honest-absence wording", async () => {
    const frame = await capture(() =>
      EvidenceTable({
        api: createTuiPluginApi(),
        data: evidence({
          records: [],
          causes: [
            { claim_id: "remaining-claim", cause: "absent" },
            { claim_id: null, cause: "unattributable" },
          ],
          rejections: [{ index: 1, reason: "malformed-record", detail: "claim_id is null", claim_id: null }],
        }),
        page: 0,
      }),
    )

    expect(frame).toContain("NO CLAIM")
    expect(frame).toContain("unattributable — no usable claim")
    expect(frame).toContain("ABSENCE WITHHELD")
    expect(frame).toContain("remaining claims are not labelled absent")
    expect(frame).not.toContain("absent — work never done")
    expect(frame).not.toContain("no evidence for required claim")
    expect(frame).not.toContain("claim remaining-claim")
  })

  test("renders no evidence and evidence refused as different facts", async () => {
    const none = await capture(() =>
      EvidenceTable({
        api: createTuiPluginApi(),
        data: evidence({ records: [], rejections: [], causes: [] }),
        page: 0,
      }),
    )
    const refused = await capture(() =>
      EvidenceTable({
        api: createTuiPluginApi(),
        data: evidence({
          records: [],
          rejections: [{ index: 0, reason: "malformed-record", detail: "missing suite_results", claim_id: CLAIM_ID }],
        }),
        page: 0,
      }),
    )

    expect(none).toContain("NO EVIDENCE")
    expect(none).not.toContain("EVIDENCE REFUSED")
    expect(refused).toContain("EVIDENCE REFUSED")
    expect(refused).not.toContain("NO EVIDENCE")
    expect(refused).not.toBe(none)
  })

  test("shows both halves of contradictory evidence and names the contradiction", async () => {
    const frame = await capture(() =>
      EvidenceTable({
        api: createTuiPluginApi(),
        data: evidence({
          records: [
            record({ suite_results_summary: "same suite: PASS", record_path: "record-pass.json" }),
            record({ suite_results_summary: "same suite: FAIL", record_path: "record-fail.json" }),
          ],
          causes: [{ claim_id: CLAIM_ID, cause: "contradicted" }],
        }),
        page: 0,
      }),
    )

    expect(frame).toContain("contradicted — evidence disagrees")
    expect(frame).toContain("same suite: PASS")
    expect(frame).toContain("same suite: FAIL")
    expect(frame.match(/ADMITTED #/g)).toHaveLength(2)
  })

  test("keeps mismatched and stale records visible with their causes", async () => {
    const data = evidence({
      records: [
        record({ command_digest: "sha256:not-bound", record_path: "mismatched.json" }),
        record({ subject_digest: "sha256:other-subject", record_path: "stale.json" }),
      ],
      causes: [
        { claim_id: CLAIM_ID, cause: "mismatched" },
        { claim_id: CLAIM_ID, cause: "stale" },
      ],
    })
    const rendered = (await capturePages(data)).join("\n")

    expect(rendered).toContain("mismatched — command does not match")
    expect(rendered).toContain("sha256:not-bound")
    expect(rendered).toContain("stale — evidence names another subject")
    expect(rendered).toContain("sha256:other-subject")
    expect(rendered.match(/ADMITTED #/g)).toHaveLength(data.records.length)
  })

  test("bounds oversized suite output and gives the full record path", async () => {
    const line = (index: number) => `suite-output-${index}`
    const raw = Array.from({ length: EVIDENCE_SUITE_OUTPUT_MAX_LINES + 2 }, (_, index) => line(index)).join("\n")
    const result = truncateEvidenceSuiteOutput(raw)
    const characterBounded = truncateEvidenceSuiteOutput("x".repeat(EVIDENCE_SUITE_OUTPUT_MAX_CHARACTERS + 1))
    const frame = await capture(() =>
      EvidenceTable({
        api: createTuiPluginApi(),
        data: evidence({ records: [record({ suite_results_summary: raw })] }),
        page: 0,
      }),
    )

    expect(result.shownCharacters).toBeLessThanOrEqual(EVIDENCE_SUITE_OUTPUT_MAX_CHARACTERS)
    expect(result.shownLines).toBe(EVIDENCE_SUITE_OUTPUT_MAX_LINES)
    expect(characterBounded.shownCharacters).toBe(EVIDENCE_SUITE_OUTPUT_MAX_CHARACTERS)
    expect(characterBounded.truncated).toBe(true)
    for (let index = 0; index < EVIDENCE_SUITE_OUTPUT_MAX_LINES; index += 1) {
      expect(frame).toContain(line(index))
    }
    expect(frame).not.toContain(line(EVIDENCE_SUITE_OUTPUT_MAX_LINES))
    expect(frame).toContain("SUITE OUTPUT TRUNCATED")
    expect(frame).toContain(RECORD_PATH)
  })

  test("renders every row of a page and its pager inside an ordinary terminal", async () => {
    const total = EVIDENCE_PAGE_SIZE * 3
    const claim = (index: number) => `evidence-${String(index).padStart(4, "0")}`
    const suiteSummary = Array.from(
      { length: EVIDENCE_SUITE_OUTPUT_MAX_LINES + 1 },
      (_, index) => `page-suite-output-${index}`,
    ).join("\n")
    const records = Array.from({ length: total }, (_, index) =>
      record({
        claim_id: claim(index),
        suite_results_summary: suiteSummary,
        record_path: `record-${index}.json`,
      }),
    )
    const data = evidence({ records })
    const first = paginateEvidenceRows(data, 0)
    const frame = await capture(() => EvidenceTable({ api: createTuiPluginApi(), data, page: 0 }), 24)

    expect(first.rows).toHaveLength(EVIDENCE_PAGE_SIZE)
    for (let index = 0; index < EVIDENCE_PAGE_SIZE; index += 1) {
      expect(frame).toContain(claim(index))
      expect(frame).toContain(`record-${index}.json`)
    }
    expect(frame).not.toContain(claim(EVIDENCE_PAGE_SIZE))
    expect(frame.match(/SUITE OUTPUT TRUNCATED/g)).toHaveLength(EVIDENCE_PAGE_SIZE)
    expect(frame).toContain(`page 1 of ${total / EVIDENCE_PAGE_SIZE}`)
    expect(frame.indexOf("page 1")).toBeLessThan(frame.indexOf(claim(0)))
  })

  test("concatenating pages preserves every evidence row in input order", () => {
    const records = Array.from({ length: EVIDENCE_PAGE_SIZE * 4 }, (_, index) => record({ claim_id: `claim-${index}` }))
    const data = evidence({ records })
    const pageCount = paginateEvidenceRows(data, 0).pageCount
    const paged = Array.from({ length: pageCount }, (_, page) => paginateEvidenceRows(data, page).rows).flat()

    expect(paged.flatMap((row) => (row.state === "admitted" ? [row.record.claim_id] : []))).toEqual(
      records.map((item) => item.claim_id),
    )
  })
})
