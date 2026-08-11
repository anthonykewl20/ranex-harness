import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import {
  RUN_OUTPUT_MAX_CHARACTERS,
  RUN_OUTPUT_MAX_LINES,
  RunDetails,
  RunPane,
  truncateRunOutput,
  type RunRecord,
} from "../src/feature-plugins/board/panes/run"
import { createTuiPluginApi } from "./fixture/tui-plugin"

const COMMAND = "uv run --frozen pytest -q"
const COMMAND_DIGEST = "sha256:7be4c1d0"
const SUBJECT_DIGEST = "sha256:15d70fd2"
const WORKTREE = ".ranex/wt/task-014"
const BRANCH = "task-014"
const DURATION_MS = 41_800

async function capture(render: () => ReturnType<typeof RunPane.render>, height = 30) {
  const app = await testRender(render, { width: 120, height })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    command: COMMAND,
    command_digest: COMMAND_DIGEST,
    bound_command_digest: COMMAND_DIGEST,
    outcome: { state: "passed", exit_code: 0 },
    duration_ms: DURATION_MS,
    worktree: { path: WORKTREE, branch: BRANCH, state: "present" },
    confinement: {
      state: "confined",
      filesystem_scope: "Landlock — read-only root, read-write worktree",
      network_posture: "denied — strict-local",
      cgroup_limits: "memory 2 GiB, pids 512",
    },
    subject_digest: SUBJECT_DIGEST,
    dependencies: { state: "approved", store: "ranex-store-v1" },
    output: "12 tests passed",
    ...overrides,
  }
}

describe("the run pane", () => {
  test("registers the reserved identity and order", () => {
    expect(RunPane).toMatchObject({ id: "ranex.board.run", title: "Run", order: 400 })
  })

  test("renders unread as unavailable, never as an empty run", async () => {
    const why = "the return channel does not exist"
    const frame = await capture(() =>
      RunPane.render({ api: createTuiPluginApi(), data: { state: "unread", why } }),
    )

    expect(frame).toContain("Run unavailable")
    expect(frame).toContain("No run record was read")
    expect(frame).toContain(why)
    expect(frame).not.toContain("PASSED")
  })

  test("an unconfined run cannot render identically to a confined run", async () => {
    const api = createTuiPluginApi()
    const unconfined = await capture(() =>
      RunDetails({
        api,
        run: run({ confinement: { state: "unconfined", reason: "kernel confinement module unavailable" } }),
      }),
    )
    const confined = await capture(() => RunDetails({ api, run: run() }))

    expect(unconfined).not.toBe(confined)
    expect(unconfined).toContain("CONFINEMENT UNCONFINED")
    expect(unconfined).toContain("kernel confinement module unavailable")
    expect(unconfined).toContain("filesystem")
    expect(unconfined).toContain("unrestricted; confinement not applied")
    expect(unconfined).toContain("network")
    expect(unconfined).toContain("cgroup")
    expect(unconfined).toContain("no limits applied")
    expect(confined).toContain("CONFINEMENT CONFINED — applied")
    expect(confined).toContain("Landlock — read-only root, read-write worktree")
    expect(confined).toContain("denied — strict-local")
    expect(confined).toContain("memory 2 GiB, pids 512")
  })

  test("renders killed, failed, and passed as three distinct states", async () => {
    const api = createTuiPluginApi()
    const passed = await capture(() => RunDetails({ api, run: run() }))
    const failed = await capture(() =>
      RunDetails({ api, run: run({ outcome: { state: "failed", exit_code: 1 } }) }),
    )
    const killed = await capture(() =>
      RunDetails({
        api,
        run: run({ outcome: { state: "killed", reason: "watchdog absolute timeout", exit_code: 137 } }),
      }),
    )

    expect(new Set([passed, failed, killed]).size).toBe(3)
    expect(passed).toContain("PASSED — exit 0")
    expect(failed).toContain("FAILED — clean exit 1")
    expect(killed).toContain("KILLED — watchdog absolute timeout; exit 137")
  })

  test("renders every run identity and provenance row", async () => {
    const frame = await capture(() => RunDetails({ api: createTuiPluginApi(), run: run() }))

    for (const value of [
      COMMAND,
      COMMAND_DIGEST,
      SUBJECT_DIGEST,
      WORKTREE,
      BRANCH,
      `${(DURATION_MS / 1_000).toFixed(1)}s`,
      "MATCHED — command digest matches the bound command",
      "dependencies APPROVED STORE — ranex-store-v1",
      "12 tests passed",
    ]) {
      expect(frame).toContain(value)
    }
  })

  test("renders a command digest mismatch as the mismatched cause", async () => {
    const bound = "sha256:expected"
    const frame = await capture(() =>
      RunDetails({ api: createTuiPluginApi(), run: run({ bound_command_digest: bound }) }),
    )

    expect(frame).toContain(COMMAND_DIGEST)
    expect(frame).toContain(bound)
    expect(frame).toContain("MISMATCHED — cause: mismatched; command digest does not match the bound command")
  })

  test("bounds oversized output and says exactly what was truncated", async () => {
    const line = (index: number) => `output-row-${index}`
    const raw = Array.from({ length: RUN_OUTPUT_MAX_LINES + 2 }, (_, index) => line(index)).join("\n")
    const result = truncateRunOutput(raw)
    const characterBounded = truncateRunOutput("x".repeat(RUN_OUTPUT_MAX_CHARACTERS + 1))
    const frame = await capture(
      () => RunDetails({ api: createTuiPluginApi(), run: run({ output: raw }) }),
      36,
    )

    expect(result.shownCharacters).toBeLessThanOrEqual(RUN_OUTPUT_MAX_CHARACTERS)
    expect(result.shownLines).toBe(RUN_OUTPUT_MAX_LINES)
    expect(characterBounded.shownCharacters).toBe(RUN_OUTPUT_MAX_CHARACTERS)
    expect(characterBounded.truncated).toBe(true)
    for (let index = 0; index < RUN_OUTPUT_MAX_LINES; index += 1) expect(frame).toContain(line(index))
    expect(frame).not.toContain(line(RUN_OUTPUT_MAX_LINES))
    expect(frame).toContain("OUTPUT TRUNCATED")
    expect(frame).toContain(`${RUN_OUTPUT_MAX_LINES} of ${RUN_OUTPUT_MAX_LINES + 2} lines`)
  })

  test("says when the worktree is gone and does not imply reproducibility", async () => {
    const frame = await capture(() =>
      RunDetails({
        api: createTuiPluginApi(),
        run: run({ worktree: { path: WORKTREE, branch: BRANCH, state: "missing" } }),
      }),
    )

    expect(frame).toContain(WORKTREE)
    expect(frame).toContain(BRANCH)
    expect(frame).toContain("MISSING at render time")
    expect(frame).toContain("run is not reproducible from this tree")
  })

  test("spells out when dependencies did not come from the approved store", async () => {
    const source = "ambient node_modules"
    const frame = await capture(() =>
      RunDetails({
        api: createTuiPluginApi(),
        run: run({ dependencies: { state: "unapproved", source } }),
      }),
    )

    expect(frame).toContain(`dependencies UNAPPROVED SOURCE — ${source}`)
    expect(frame).not.toContain("dependencies APPROVED STORE")
  })
})
