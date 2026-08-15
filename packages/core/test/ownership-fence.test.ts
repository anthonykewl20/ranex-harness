import { expect, test } from "bun:test"
import { Database } from "@ranex/core/database/database"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Project } from "@ranex/core/project"
import { ProjectTable } from "@ranex/core/project/sql"
import { SessionV2 } from "@ranex/core/session"
import { SessionStore } from "@ranex/core/session/store"
import { SessionTable } from "@ranex/core/session/sql"
import { AbsolutePath } from "@ranex/core/schema"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const worker = join(import.meta.dir, "fixture/ownership-fence-worker.ts")
// Each case cold-starts one or more Bun worker processes while the core suite runs test files in parallel; matches the budget used by session-reconcile-fence.test.ts.
const workerTestTimeout = 30_000

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ranex-ownership-fence-"))
  return {
    dir,
    dbFile: join(dir, "shared.db"),
    state: join(dir, "state"),
    logFile: join(dir, "dispatch.log"),
    sessionID: SessionV2.ID.make(`ses_fence_${crypto.randomUUID()}`),
  }
}

async function seed(input: ReturnType<typeof fixture>, owner?: string) {
  const layer = AppNodeBuilder.build(LayerNode.group([Database.node, SessionStore.node]), [
    [Database.node, Database.layerFromPath(input.dbFile)],
  ])
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: input.sessionID,
          project_id: Project.ID.global,
          slug: input.sessionID,
          directory: "/project",
          title: "fence",
          version: "test",
          execution_owner: owner,
        })
        .run()
        .pipe(Effect.orDie)
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )
}

function runWorker(
  input: ReturnType<typeof fixture>,
  mode: "fenced" | "unfenced" | "claim",
  name: string,
  hold = 250,
  releaseFile?: string,
  startFile?: string,
) {
  const readyFile = join(input.dir, `${name}.ready`)
  const child = spawn(process.execPath, [worker, JSON.stringify({ ...input, mode, readyFile, hold, releaseFile, startFile })], {
    cwd: join(import.meta.dir, ".."),
    stdio: ["ignore", "ignore", "pipe"],
  })
  const stderr: Buffer[] = []
  child.stderr.on("data", (chunk) => stderr.push(chunk))
  return {
    readyFile,
    done: new Promise<{ code: number | null; stderr: string }>((resolve) =>
      child.on("close", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString() })),
    ),
  }
}

async function waitFor(path: string) {
  const deadline = Date.now() + workerTestTimeout
  while (!(await Bun.file(path).exists())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`)
    await Bun.sleep(10)
  }
}

function assertWorkersOk(results: { code: number | null; stderr: string }[]) {
  const failures = results.filter((result) => result.code !== 0)
  expect(failures.map((result) => `exit=${result.code}\n${result.stderr}`).join("\n")).toBe("")
}

async function owner(input: ReturnType<typeof fixture>) {
  const layer = AppNodeBuilder.build(LayerNode.group([Database.node, SessionStore.node]), [
    [Database.node, Database.layerFromPath(input.dbFile)],
  ])
  return Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* SessionStore.Service
      return yield* store.executionOwner(input.sessionID)
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )
}

test("BASELINE: unfenced processes double-dispatch", async () => {
  const input = fixture()
  try {
    await seed(input)
    const startFile = join(input.dir, "start")
    const workers = [
      runWorker(input, "unfenced", "a", 80, undefined, startFile),
      runWorker(input, "unfenced", "b", 80, undefined, startFile),
    ]
    await Promise.all(workers.map((item) => waitFor(item.readyFile)))
    await Bun.write(startFile, "start")
    assertWorkersOk(await Promise.all(workers.map((item) => item.done)))
    expect((await Bun.file(input.logFile).text()).trim().split("\n")).toHaveLength(2)
  } finally {
    rmSync(input.dir, { recursive: true, force: true })
  }
}, workerTestTimeout)

test("GREEN: shared flock and CAS allow exactly one overlapping dispatch", async () => {
  const input = fixture()
  try {
    await seed(input)
    const workers = [runWorker(input, "fenced", "a", 80), runWorker(input, "fenced", "b", 80)]
    assertWorkersOk(await Promise.all(workers.map((item) => item.done)))
    expect((await Bun.file(input.logFile).text()).trim().split("\n")).toHaveLength(1)
    expect(await owner(input)).toBeUndefined()
  } finally {
    rmSync(input.dir, { recursive: true, force: true })
  }
}, workerTestTimeout)

test("ISOLATION: CAS alone refuses a second live owner", async () => {
  const input = fixture()
  try {
    await seed(input)
    const releaseFile = join(input.dir, "release")
    const a = runWorker(input, "claim", "a", 0, releaseFile)
    await waitFor(a.readyFile)
    const b = runWorker(input, "claim", "b", 20)
    assertWorkersOk([await b.done])
    expect(await owner(input)).toBe(await Bun.file(a.readyFile).text())
    await Bun.write(releaseFile, "release")
    assertWorkersOk([await a.done])
  } finally {
    rmSync(input.dir, { recursive: true, force: true })
  }
}, workerTestTimeout)

test("sad path 7: owner is live while busy and cleared after idle", async () => {
  const input = fixture()
  try {
    await seed(input)
    const a = runWorker(input, "fenced", "a", 80)
    await waitFor(a.readyFile)
    expect(await owner(input)).toBe(await Bun.file(a.readyFile).text())
    assertWorkersOk([await a.done])
    expect(await owner(input)).toBeUndefined()
  } finally {
    rmSync(input.dir, { recursive: true, force: true })
  }
}, workerTestTimeout)

test("owner release lets a later process acquire", async () => {
  const input = fixture()
  try {
    await seed(input)
    const a = runWorker(input, "fenced", "a", 20)
    assertWorkersOk([await a.done])
    rmSync(input.logFile, { force: true })
    const b = runWorker(input, "fenced", "b", 20)
    assertWorkersOk([await b.done])
    expect((await Bun.file(input.logFile).text()).trim()).toBe(await Bun.file(b.readyFile).text())
    expect(await owner(input)).toBeUndefined()
  } finally {
    rmSync(input.dir, { recursive: true, force: true })
  }
}, workerTestTimeout)

test("stale owner is reclaimed by CAS", async () => {
  const input = fixture()
  try {
    await seed(input, "4000000:00000000-0000-4000-8000-000000000000:0")
    const worker = runWorker(input, "claim", "new", 20)
    assertWorkersOk([await worker.done])
    expect(await owner(input)).toBe(await Bun.file(worker.readyFile).text())
  } finally {
    rmSync(input.dir, { recursive: true, force: true })
  }
}, workerTestTimeout)
