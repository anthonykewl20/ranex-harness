/**
 * Process-crash regressions against SQLite `synchronous = NORMAL`; these do not
 * claim power-loss durability. The watchdog regression already lives in
 * session-runner.test.ts under "SessionRunnerLLM provider watchdog": it drives
 * one real `llm.stream` call through idle and absolute budgets to terminal error.
 * ownership-fence.test.ts retains the two-live-process double-drain baseline.
 * The two tests here deliberately use SIGKILL; graph teardown remains covered by
 * session-runner-reconciler.test.ts and the shared testEffect scoped runner.
 */
import { expect, test } from "bun:test"
import { Database } from "@ranex/core/database/database"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { EventV2 } from "@ranex/core/event"
import { EventTable } from "@ranex/core/event/sql"
import { Project } from "@ranex/core/project"
import { ProjectTable } from "@ranex/core/project/sql"
import { AbsolutePath } from "@ranex/core/schema"
import { SessionV2 } from "@ranex/core/session"
import { SessionEvent } from "@ranex/core/session/event"
import { SessionMessage } from "@ranex/core/session/message"
import { SessionProjector } from "@ranex/core/session/projector"
import { SessionStore } from "@ranex/core/session/store"
import { SessionTable } from "@ranex/core/session/sql"
import { Effect, Layer } from "effect"
import type { Scope } from "effect/Scope"
import { eq } from "drizzle-orm"
import { spawn } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const ownershipWorker = join(import.meta.dir, "fixture/ownership-fence-worker.ts")
const reconcileWorker = join(import.meta.dir, "fixture/reconcile-fence-worker.ts")

function runInGraph<A, E, E2, R>(layer: Layer.Layer<R, E2>, program: Effect.Effect<A, E, Scope | R>) {
  return Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer)))
}

function layer(dbFile: string) {
  return AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node]),
    [[Database.node, Database.layerFromPath(dbFile)]],
  )
}

function seed(sessionID: SessionV2.ID) {
  return Effect.gen(function* () {
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
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: "/project",
        title: "durability regression",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function startWorker(file: string, input: Record<string, unknown>) {
  const proc = spawn(process.execPath, [file, JSON.stringify(input)], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  })
  const stderr: Buffer[] = []
  proc.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
    proc.on("error", reject)
    proc.on("close", (code, signal) => resolve({ code, signal, stderr: Buffer.concat(stderr).toString() }))
  })
  return { proc, done }
}

async function waitFor(file: string) {
  const deadline = Date.now() + 5_000
  while (!(await Bun.file(file).exists())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`)
    await Bun.sleep(10)
  }
}

function assertWorkerOk(result: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) {
  expect(result.code === 0 ? "" : `exit=${result.code ?? result.signal}\n${result.stderr}`).toBe("")
}

function assistantTool(messages: ReadonlyArray<SessionMessage.Message>) {
  const assistants = messages.filter((message) => message.type === "assistant")
  expect(assistants).toHaveLength(1)
  const tool = assistants[0]?.content.find((content) => content.type === "tool")
  if (!tool || tool.type !== "tool") throw new Error("No projected tool")
  return tool
}

test("SIGKILL releases the Session fence and one fresh process takes over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranex-regression-fence-"))
  const dbFile = join(dir, "shared.db")
  const sessionID = SessionV2.ID.make(`ses_regression_fence_${crypto.randomUUID()}`)
  const state = join(dir, "state")
  const logFile = join(dir, "dispatch.log")
  const firstReady = join(dir, "first.ready")
  try {
    await runInGraph(layer(dbFile), seed(sessionID))
    const first = startWorker(ownershipWorker, {
      mode: "fenced",
      dbFile,
      state,
      sessionID,
      logFile,
      readyFile: firstReady,
      hold: 60_000,
    })
    await waitFor(firstReady)
    first.proc.kill("SIGKILL")
    const killed = await first.done
    expect(killed.signal).toBe("SIGKILL")
    const lockDir = join(state, "locks", readdirSync(join(state, "locks"))[0] ?? "missing")
    // Avoid waiting a minute while preserving production's stale-heartbeat path.
    const stale = new Date(Date.now() - 61_000)
    utimesSync(join(lockDir, "heartbeat"), stale, stale)

    const secondReady = join(dir, "second.ready")
    const second = startWorker(ownershipWorker, {
      mode: "fenced",
      dbFile,
      state,
      sessionID,
      logFile,
      readyFile: secondReady,
      hold: 0,
    })
    assertWorkerOk(await second.done)
    expect((await Bun.file(logFile).text()).trim()).toBe((await Bun.file(secondReady).text()).trim())
    await runInGraph(
      layer(dbFile),
      Effect.gen(function* () {
        const store = yield* SessionStore.Service
        expect(yield* store.executionOwner(sessionID)).toBeUndefined()
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

test("startup sweep reconciles an empty-inbox tool after its process is SIGKILLed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ranex-regression-reconcile-"))
  const dbFile = join(dir, "shared.db")
  const sessionID = SessionV2.ID.make(`ses_regression_reconcile_${crypto.randomUUID()}`)
  const readyFile = join(dir, "stranded.ready")
  try {
    await runInGraph(layer(dbFile), seed(sessionID))
    const stranded = startWorker(reconcileWorker, { mode: "strand", dbFile, sessionID, readyFile })
    await waitFor(readyFile)
    await runInGraph(
      layer(dbFile),
      Effect.gen(function* () {
        const store = yield* SessionStore.Service
        expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("running")
      }),
    )
    stranded.proc.kill("SIGKILL")
    const killed = await stranded.done
    expect(killed.signal).toBe("SIGKILL")

    const sweep = startWorker(reconcileWorker, {
      mode: "sweep",
      dbFile,
      sessionID,
      readyFile: join(dir, "unused"),
    })
    assertWorkerOk(await sweep.done)
    await runInGraph(
      layer(dbFile),
      Effect.gen(function* () {
        const store = yield* SessionStore.Service
        const { db } = yield* Database.Service
        expect(assistantTool(yield* store.context(sessionID)).state.status).toBe("error")
        expect(
          yield* db
            .select({ type: EventTable.type })
            .from(EventTable)
            .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Tool.Failed.type, 1)))
            .all()
            .pipe(Effect.orDie),
        ).toHaveLength(1)
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
