/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { testRender } from "@opentui/solid"
import type { TuiPluginApi } from "@ranex/plugin/tui"
import { DIFF_VIEWER_ROUTE } from "../src/feature-plugins/system/diff-viewer"
import {
  DIFF_PATCH_MAX_CHARACTERS,
  SubjectBindingNotice,
  prepareBoundDiffFiles,
  subjectDiffFiles,
  type SubjectDiffBinding,
} from "../src/feature-plugins/board/diff-binding"
import { DiffDetails, DiffPane, openSubjectDiff } from "../src/feature-plugins/board/panes/diff"
import { PANES } from "../src/feature-plugins/board/panes"
import { createTuiPluginApi } from "./fixture/tui-plugin"

const ROOT = path.join(import.meta.dir, "..")
const SOURCE = readFileSync(path.join(ROOT, "src/feature-plugins/board/panes/diff.tsx"), "utf8")
const VIEWER_SOURCE = readFileSync(path.join(ROOT, "src/feature-plugins/system/diff-viewer.tsx"), "utf8")
// The judgement lives in a Ranex-owned module, not in opencode's viewer: ADR-018
// keeps divergence out of files upstream owns, so that is where these assert.
const BINDING_SOURCE = readFileSync(path.join(ROOT, "src/feature-plugins/board/diff-binding.tsx"), "utf8")
const SUBJECT_DIGEST = "sha256:subject-bound"

function binding(overrides: Partial<SubjectDiffBinding> = {}): SubjectDiffBinding {
  return {
    verdictDigest: SUBJECT_DIGEST,
    diffDigest: SUBJECT_DIGEST,
    workingTreeDigest: SUBJECT_DIGEST,
    reviewState: "not-reviewed",
    files: [
      {
        file: "src/bound-change.ts",
        additions: 1,
        deletions: 1,
        status: "modified",
        patch: "--- a/src/bound-change.ts\n+++ b/src/bound-change.ts\n@@ -1 +1 @@\n-old\n+new",
      },
    ],
    ...overrides,
  }
}

async function capture(render: () => ReturnType<typeof DiffPane.render>, height = 24) {
  const app = await testRender(render, { width: 120, height })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

describe("the board diff pane", () => {
  test("registers the reserved identity and order", () => {
    expect(DiffPane).toMatchObject({ id: "ranex.board.diff", title: "Diff", order: 500 })
    expect(PANES).toContain(DiffPane)
  })

  test("renders unread as unavailable, never as an empty reviewed change", async () => {
    const frame = await capture(() =>
      DiffPane.render({
        api: createTuiPluginApi(),
        data: { state: "unread", why: "the return channel does not exist" },
      }),
    )

    for (const row of ["Diff unavailable", "No verdict or subject-bound diff was read", "the return channel does not exist"]) {
      expect(frame).toContain(row)
    }
    expect(frame).not.toContain("REVIEWED")
  })

  test("renders every bound row inside an ordinary terminal and uses semantic diff colors", async () => {
    const current = binding()
    const frame = await capture(() => DiffDetails({ api: createTuiPluginApi(), binding: current }))

    for (const row of [
      "verdict subject",
      "diff tree",
      "working tree",
      current.verdictDigest,
      "BOUND — diff and verdict name the same current tree",
      "REVIEW STATE: NOT REVIEWED",
      "+1 added",
      "-1 removed",
      "1 file",
      "Reviewing is not approving",
      "open bound diff in existing viewer",
    ]) {
      expect(frame).toContain(row)
    }
    expect(SOURCE).toContain("theme().diffAdded")
    expect(SOURCE).toContain("theme().diffRemoved")
  })

  test("opens the existing viewer with the immutable subject binding", () => {
    const calls: { name: string; params?: Record<string, unknown> }[] = []
    let cleared = false
    const current = binding()
    const api = {
      route: {
        current: { name: "ranex.board" },
        navigate(name: string, params?: Record<string, unknown>) {
          calls.push({ name, params })
        },
      },
      ui: {
        dialog: {
          clear() {
            cleared = true
          },
        },
      },
    } as unknown as TuiPluginApi

    openSubjectDiff(api, current)

    expect(calls).toEqual([
      {
        name: DIFF_VIEWER_ROUTE,
        params: { mode: "git", subjectBinding: current, returnRoute: { name: "ranex.board" } },
      },
    ])
    expect(cleared).toBe(true)
  })

  test("introduces no second diff renderer", () => {
    expect(SOURCE).toContain('from "../../system/diff-viewer"')
    expect(SOURCE).not.toMatch(/<diff(?:\s|>)/)
    expect(SOURCE).not.toContain("DiffRenderable")
    expect(SOURCE).not.toMatch(/\.patch\.(?:split|replace|match)/)
  })
})

describe("the subject-bound existing diff viewer", () => {
  test("always names the digest of the tree it is showing", async () => {
    const frame = await capture(() => SubjectBindingNotice({ api: createTuiPluginApi(), binding: binding() }), 12)

    for (const row of [
      `verdict subject digest ${SUBJECT_DIGEST}`,
      `diff tree digest ${SUBJECT_DIGEST}`,
      `working tree digest ${SUBJECT_DIGEST}`,
      "REVIEW STATE: NOT REVIEWED",
      "Reviewing is not approving",
    ]) {
      expect(frame).toContain(row)
    }
  })

  test("refuses a digest mismatch before the reviewed change can render", async () => {
    const diffDigest = "sha256:different-diff"
    const mismatched = binding({ diffDigest, reviewState: "reviewed" })
    const frame = await capture(
      () => SubjectBindingNotice({ api: createTuiPluginApi(), binding: mismatched }),
      12,
    )

    for (const row of [
      `verdict subject digest ${SUBJECT_DIGEST}`,
      `diff tree digest ${diffDigest}`,
      `REFUSED — diff digest ${diffDigest} does not match verdict digest ${SUBJECT_DIGEST}`,
      "REVIEW STATE: REFUSED",
      "is not applied to this change",
    ]) {
      expect(frame).toContain(row)
    }
    expect(frame).not.toContain("REVIEW STATE: REVIEWED")
    expect(subjectDiffFiles(mismatched)).toEqual([])
    // The refusal arm must precede the patch list, or a mismatched diff renders
    // before anything says it is the wrong tree.
    expect(VIEWER_SOURCE.indexOf('subjectDiffBindingState(subjectBinding()!) === "mismatched"')).toBeLessThan(
      VIEWER_SOURCE.indexOf("<For each={visiblePatchFiles()}"),
    )
    expect(BINDING_SOURCE).toContain("mismatched diff is not rendered as the reviewed change")
  })

  test("marks a moved working tree stale while showing only the bound snapshot", async () => {
    const workingTreeDigest = "sha256:working-tree-moved"
    const stale = binding({ workingTreeDigest, reviewState: "reviewed" })
    const frame = await capture(() => SubjectBindingNotice({ api: createTuiPluginApi(), binding: stale }), 12)

    for (const row of [
      `working tree digest ${workingTreeDigest}`,
      `STALE — working tree ${workingTreeDigest} moved from verdict subject ${SUBJECT_DIGEST}`,
      "REVIEW STATE: STALE",
      "only to the bound snapshot below",
    ]) {
      expect(frame).toContain(row)
    }
    expect(frame).not.toContain("REVIEW STATE: REVIEWED")
    expect(subjectDiffFiles(stale).map((file) => file.file)).toEqual(["src/bound-change.ts"])
  })

  test("renders no change for an empty bound change", async () => {
    const frame = await capture(() =>
      DiffDetails({ api: createTuiPluginApi(), binding: binding({ files: [] }) }),
    )

    expect(frame).toContain("no change — the bound subject contains no changed files")
    expect(frame).toContain(SUBJECT_DIGEST)
    expect(frame).not.toContain("src/bound-change.ts")
  })

  test("summarises binary and oversized files instead of rendering their patches", () => {
    const binary = prepareBoundDiffFiles([
      {
        file: "assets/image.bin",
        additions: 0,
        deletions: 0,
        status: "modified",
        patch: "GIT binary patch\nliteral 100",
      },
    ])[0]
    const oversizedCharacters = DIFF_PATCH_MAX_CHARACTERS + 1
    const oversized = prepareBoundDiffFiles([
      {
        file: "generated/large.txt",
        additions: 1,
        deletions: 0,
        status: "modified",
        patch: "x".repeat(oversizedCharacters),
      },
    ])[0]

    expect(binary).toMatchObject({
      file: "assets/image.bin",
      patchNotice: "BINARY FILE — patch not rendered; file summary only.",
    })
    expect(oversized).toMatchObject({
      file: "generated/large.txt",
      patchNotice: `PATCH TRUNCATED — too large to render; ${oversizedCharacters} characters withheld; file summary only.`,
    })
    expect(binary?.patch).toBeUndefined()
    expect(oversized?.patch).toBeUndefined()
    // The notice is shown when there is one, and upstream's own wording survives
    // when there is not — a bound-path improvement must not become divergence.
    expect(VIEWER_SOURCE).toContain("entry.file.patchNotice ??")
    expect(VIEWER_SOURCE).toContain('"No patch available for this file."')
  })
})
