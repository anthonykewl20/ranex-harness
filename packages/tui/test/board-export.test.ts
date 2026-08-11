import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { performExport } from "../src/feature-plugins/board/actions"
import { projectBoard, type BoardProjectionRecord } from "../src/feature-plugins/board/projection"

const RECORD: BoardProjectionRecord = {
  subject_digest: "sha256:subject-one",
  gate_id: { state: "available", value: "landing" },
  catalog_digest: { state: "available", value: "sha256:catalog" },
  verdict: "FAIL",
  causes: {
    state: "available",
    value: [
      { claim_id: "tests", cause: "failed", detail: "one test failed" },
      { claim_id: null, cause: "absent" },
    ],
  },
  filters: [{ name: "gate", value: "landing" }],
}

describe("board export projection", () => {
  test("is byte-identical for identical durable state and changes with the subject", () => {
    expect(projectBoard(RECORD)).toBe(projectBoard(RECORD))
    expect(projectBoard(RECORD)).not.toBe(projectBoard({ ...RECORD, subject_digest: "sha256:subject-two" }))
  })

  test("names the subject and says it is not a signed record", () => {
    const output = projectBoard(RECORD)
    expect(output).toContain(RECORD.subject_digest)
    expect(output).toContain("gate id: landing")
    expect(output).toContain("catalog digest: sha256:catalog")
    expect(output).toContain("verdict: FAIL")
    expect(output).toContain("cause: failed")
    expect(output).toContain("cause: absent")
    expect(output).toContain("name: gate")
    expect(output).toContain("PROJECTION")
    expect(output).toContain("not a signed record")
  })

  test("refuses to project an unbound record", () => {
    expect(() => projectBoard({ ...RECORD, subject_digest: "" })).toThrow("subject digest")
  })

  test("refuses without a subject and creates no file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ranex-board-export-"))
    const destination = path.join(directory, "board.txt")

    try {
      expect(
        performExport("no-subject", { state: "unread", why: "no verdict was read" }, destination, false).kind,
      ).toBe("refused")
      expect(await Bun.file(destination).exists()).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("writes exactly the unstyled projection to a regular file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ranex-board-export-"))
    const destination = path.join(directory, "board.txt")

    try {
      const outcome = performExport(
        "subject-read",
        { state: "read", record: { verdict: "PASS", subject_digest: "sha256:written" } },
        destination,
        false,
      )
      expect(outcome.kind).toBe("done")
      expect(await Bun.file(destination).text()).toContain("subject digest: sha256:written")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("refuses an unwritable destination without publishing a partial file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ranex-board-export-"))
    const destination = path.join(directory, "missing", "board.txt")

    try {
      const outcome = performExport(
        "subject-read",
        { state: "read", record: { verdict: "PASS", subject_digest: "sha256:written" } },
        destination,
        false,
      )
      expect(outcome.kind).toBe("refused")
      expect(await Bun.file(destination).exists()).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("the projection and executor have no journal write path", async () => {
    const sources = await Promise.all([
      Bun.file(path.join(import.meta.dir, "../src/feature-plugins/board/projection.ts")).text(),
      Bun.file(path.join(import.meta.dir, "../src/feature-plugins/board/actions.ts")).text(),
    ])
    for (const source of sources) expect(source).not.toMatch(/\bjournal\.(?:append|write)\b/)
  })
})
