// SLICE-011 claim 5 — ownership fencing prototype orchestrator.
//
// Three observed scenarios, each against a FRESH tmp dir + shared SQLite file:
//   1. BASELINE (fence OFF): two processes drain ONE session concurrently.
//      Proves the double-drain is real (the in-memory coordinator Map at
//      run-coordinator.ts:28 is per-process; the shared DB at database.ts:53
//      is not fenced). Observed: 2 overlapping drain_log rows, two owners.
//   2. GREEN (fence ON): EffectFlock (util/effect-flock.ts) keyed on sessionID
//      + event_sequence.owner_id claim/refuse (event.ts:254/274/291/525)
//      refuses the second owner. Observed: 1 drain_log row, one drained +
//      one refused. s.p.7: while busy, owner_id is the valid owner; after,
//      no worker leaves the session active.
//   3. NEGATIVE CONTROL (fence OFF again): the double-drain recurs, proving
//      the fence is the causal factor (independent of the implementation).

import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "bun:sqlite"
import { SESSION_ID, SCHEMA_SQL, type DrainRow, type Outcome } from "./schema"

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "worker.ts")
const HOLD_MS = 400

type Msg = {
  dbPath: string
  lockDir: string
  sessionID: string
  owner: string
  fence: boolean
  ownerOnly: boolean
  holdMs: number
  readyFile?: string
  startAfterFile?: string
  inDrainFile?: string
  outcomeFile: string
}

function spawnWorker(msg: Msg) {
  const proc = spawn(process.execPath, [worker, JSON.stringify(msg)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const stderr: Buffer[] = []
  proc.stderr?.on("data", (d) => stderr.push(Buffer.from(d)))
  const done = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    proc.on("close", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString() }))
  })
  return done
}

async function freshTmp(prefix: string) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `s011-fence-${prefix}-`))
  return {
    tmp,
    dbPath: path.join(tmp, "session.db"),
    lockDir: path.join(tmp, "locks"),
    outcomeFile: path.join(tmp, "outcomes.log"),
  }
}

function openDb(dbPath: string) {
  const db = new Database(dbPath, { readonly: false, readwrite: true })
  return db
}

async function prepareDb(dbPath: string) {
  // The orchestrator owns DB/file creation so two concurrently-starting workers
  // never race to CREATE the file or the schema.
  const db = new Database(dbPath, { create: true, readwrite: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA busy_timeout = 5000")
  for (const sql of SCHEMA_SQL) db.run(sql)
  db.close()
}

function readDrainRows(db: Database): DrainRow[] {
  return db
    .query("SELECT rowid AS rowid, session_id AS session_id, owner AS owner, started_at AS started_at, ended_at AS ended_at FROM drain_log ORDER BY rowid")
    .all() as DrainRow[]
}

function readOwner(db: Database): string | null {
  const row = db.query("SELECT owner_id AS owner_id FROM event_sequence WHERE aggregate_id = ?").get(SESSION_ID) as { owner_id: string | null } | null
  return row?.owner_id ?? null
}

async function readOutcomes(file: string): Promise<Outcome[]> {
  const text = await fs.readFile(file, "utf8")
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Outcome)
}

function overlap(a: DrainRow, b: DrainRow) {
  if (a.ended_at == null || b.ended_at == null) return false
  return a.started_at < b.ended_at && b.started_at < a.ended_at
}

function summarizeRows(rows: DrainRow[]) {
  return rows
    .map((r) => `#${r.rowid} owner=${r.owner} [${r.started_at}..${r.ended_at}] dur=${r.ended_at != null ? r.ended_at - r.started_at : "?"}ms`)
    .join("\n  ")
}

type WorkerResult = { code: number | null; stderr: string }

// Every worker's captured stderr must surface on failure. spawnWorker collects
// stderr but a bare code assertion drops it on the floor — which is how a
// startup crash read as a silent, signal-less flake. Throw with the stderr
// inlined so the failure names the cause.
function assertWorkersOk(results: WorkerResult[], owners: string[]) {
  const crashed = results
    .map((r, i) => (r.code !== 0 ? `worker[${owners[i]}] exit=${r.code} stderr=${r.stderr || "(empty)"}` : null))
    .filter((v): v is string => v !== null)
  if (crashed.length > 0) throw new Error(`worker subprocess crashed (startup/DB/drain failure):\n${crashed.join("\n")}`)
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("SLICE-011 claim 5 — ownership fencing", () => {
  test("BASELINE: two processes double-drain one session (fence OFF)", async () => {
    const env = await freshTmp("baseline")
    try {
      const base: Omit<Msg, "owner"> = {
        dbPath: env.dbPath,
        lockDir: env.lockDir,
        sessionID: SESSION_ID,
        fence: false,
        ownerOnly: false,
        holdMs: HOLD_MS,
        outcomeFile: env.outcomeFile,
      }

      const t0 = Date.now()
      await prepareDb(env.dbPath)
      const results = await Promise.all([
        spawnWorker({ ...base, owner: "A" }),
        spawnWorker({ ...base, owner: "B" }),
      ])
      assertWorkersOk(results, ["A", "B"])
      const wall = Date.now() - t0

      const db = openDb(env.dbPath)
      const rows = readDrainRows(db)
      const outcomes = await readOutcomes(env.outcomeFile)
      db.close()

      const drained = outcomes.filter((o) => o.result === "drained")
      const pair = rows.length === 2 ? overlap(rows[0], rows[1]) : false

      console.log("\n========== BASELINE (fence OFF) — double-drain reproduction ==========")
      console.log(`  shared DB      : ${env.dbPath}`)
      console.log(`  drain_log rows : ${rows.length}`)
      console.log(`  rows:\n  ${summarizeRows(rows)}`)
      console.log(`  outcomes       : ${outcomes.map((o) => `${o.owner}=${o.result}`).join(", ")}`)
      console.log(`  wall (both)    : ${wall}ms  (hold each = ${HOLD_MS}ms)`)
      console.log(`  CONCURRENT?    : ${pair ? "YES — time ranges overlap (double-drain)" : "no"}`)
      console.log("=====================================================================\n")

      // RED: the unsafe control is real.
      expect(rows.length).toBe(2)
      expect(rows.map((r) => r.owner).sort()).toEqual(["A", "B"])
      expect(drained.length).toBe(2)
      expect(pair).toBe(true)
    } finally {
      await fs.rm(env.tmp, { recursive: true, force: true })
    }
  }, 30_000)

  test("GREEN: flock + owner_id refuses the second owner (fence ON)", async () => {
    const env = await freshTmp("green")
    try {
      const aReady = path.join(env.tmp, "a-ready")
      const aInDrain = path.join(env.tmp, "a-in-drain")

      await prepareDb(env.dbPath)
      const results = await Promise.all([
        spawnWorker({
          dbPath: env.dbPath,
          lockDir: env.lockDir,
          sessionID: SESSION_ID,
          owner: "A",
          fence: true,
          ownerOnly: false,
          holdMs: HOLD_MS,
          readyFile: aReady,
          inDrainFile: aInDrain,
          outcomeFile: env.outcomeFile,
        }),
        spawnWorker({
          dbPath: env.dbPath,
          lockDir: env.lockDir,
          sessionID: SESSION_ID,
          owner: "B",
          fence: true,
          ownerOnly: false,
          holdMs: HOLD_MS,
          startAfterFile: aReady,
          outcomeFile: env.outcomeFile,
        }),
      ])
      assertWorkersOk(results, ["A", "B"])

      const db = openDb(env.dbPath)
      const rows = readDrainRows(db)
      const finalOwner = readOwner(db)
      const outcomes = await readOutcomes(env.outcomeFile)
      db.close()

      const drained = outcomes.find((o) => o.result === "drained")
      const refused = outcomes.find((o) => o.result === "refused")

      console.log("\n========== GREEN (fence ON) — second owner refused ==========")
      console.log(`  shared DB      : ${env.dbPath}`)
      console.log(`  drain_log rows : ${rows.length}`)
      if (rows.length > 0) console.log(`  rows:\n  ${summarizeRows(rows)}`)
      console.log(`  outcomes       : ${outcomes.map((o) => `${o.owner}=${o.result}${o.conflict ? `(owner=${o.conflict})` : ""}`).join(", ")}`)
      console.log(`  final owner_id : ${finalOwner}`)
      console.log(`  activeAfter    : ${outcomes.map((o) => `${o.owner}={${o.activeAfter.join(",")}}`).join("  ")}`)
      console.log("=============================================================\n")

      // GREEN: exactly one owner drained; the other was refused by owner_id.
      expect(rows.length).toBe(1)
      expect(drained).toBeDefined()
      expect(refused).toBeDefined()
      expect(refused!.conflict).toBe(drained!.owner)
      expect(rows[0].owner).toBe(drained!.owner)
      // the flock serialised B behind A; B's drain started after A finished.
      expect(refused!.owner).not.toBe(drained!.owner)

      // s.p.7: no session left busy with no valid owner.
      //  - the drained owner is the durable owner recorded in event_sequence
      //  - neither worker leaves the session in its active set after run
      expect(finalOwner).toBe(drained!.owner)
      for (const o of outcomes) expect(o.activeAfter).not.toContain(SESSION_ID)
    } finally {
      await fs.rm(env.tmp, { recursive: true, force: true })
    }
  }, 30_000)

  test("GREEN isolation: owner_id ALONE refuses a concurrent second owner (no flock)", async () => {
    // Closes the reviewer gap: in the GREEN test above, the flock serialises B
    // behind A, so owner_id's protective value under TRUE concurrency (both
    // processes racing into the claim transaction simultaneously) was never
    // isolated. Here the flock is removed entirely; only the atomic owner_id
    // claim/refuse transaction (mirroring event.ts:254/291/525) guards the
    // drain. If owner_id is load-bearing, exactly one of two concurrently
    // started owners drains and the other is refused — proving it is not
    // decoration alongside the flock.
    const env = await freshTmp("isol")
    try {
      const base: Omit<Msg, "owner"> = {
        dbPath: env.dbPath,
        lockDir: env.lockDir,
        sessionID: SESSION_ID,
        fence: false,
        ownerOnly: true,
        holdMs: HOLD_MS,
        outcomeFile: env.outcomeFile,
      }

      await prepareDb(env.dbPath)
      const results = await Promise.all([
        spawnWorker({ ...base, owner: "A" }),
        spawnWorker({ ...base, owner: "B" }),
      ])
      assertWorkersOk(results, ["A", "B"])

      const db = openDb(env.dbPath)
      const rows = readDrainRows(db)
      const finalOwner = readOwner(db)
      const outcomes = await readOutcomes(env.outcomeFile)
      db.close()

      const drained = outcomes.find((o) => o.result === "drained")
      const refused = outcomes.find((o) => o.result === "refused")

      console.log("\n========== ISOLATION (owner_id only, NO flock) — concurrent refuse ==========")
      console.log(`  drain_log rows : ${rows.length}`)
      if (rows.length > 0) console.log(`  rows:\n  ${summarizeRows(rows)}`)
      console.log(`  outcomes       : ${outcomes.map((o) => `${o.owner}=${o.result}${o.conflict ? `(owner=${o.conflict})` : ""}`).join(", ")}`)
      console.log(`  final owner_id : ${finalOwner}`)
      console.log("===============================================================================\n")

      // owner_id alone is load-bearing: one drained, one refused, one row.
      expect(rows.length).toBe(1)
      expect(drained).toBeDefined()
      expect(refused).toBeDefined()
      expect(refused!.conflict).toBe(drained!.owner)
      expect(finalOwner).toBe(drained!.owner)
    } finally {
      await fs.rm(env.tmp, { recursive: true, force: true })
    }
  }, 30_000)

  test("GREEN s.p.7: while busy the session has a valid owner (sampled live)", async () => {
    const env = await freshTmp("sp7")
    try {
      const aReady = path.join(env.tmp, "a-ready")
      const aInDrain = path.join(env.tmp, "a-in-drain")

      await prepareDb(env.dbPath)
      const a = spawnWorker({
        dbPath: env.dbPath,
        lockDir: env.lockDir,
        sessionID: SESSION_ID,
        owner: "A",
        fence: true,
        ownerOnly: false,
        holdMs: HOLD_MS,
        readyFile: aReady,
        inDrainFile: aInDrain,
        outcomeFile: env.outcomeFile,
      })
      // wait until A is actually mid-drain, then sample the durable owner.
      let sampled: string | null = null
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const exists = await fs.stat(aInDrain).then(() => true).catch(() => false)
        if (exists) {
          const db = openDb(env.dbPath)
          sampled = readOwner(db)
          db.close()
          break
        }
        await new Promise((r) => setTimeout(r, 5))
      }

      const res = await a
      assertWorkersOk([res], ["A"])

      console.log("\n========== s.p.7 — busy session has a valid owner (live sample) ==========")
      console.log(`  in-drain marker seen, owner_id sampled = ${sampled}`)
      console.log("========================================================================\n")

      // s.p.7: while the session is busy draining, event_sequence.owner_id is a
      // valid (non-null) owner — never busy with no owner.
      expect(sampled).toBe("A")
    } finally {
      await fs.rm(env.tmp, { recursive: true, force: true })
    }
  }, 30_000)

  test("NEGATIVE CONTROL: fence OFF double-drain recurs", async () => {
    const env = await freshTmp("negctl")
    try {
      const base: Omit<Msg, "owner"> = {
        dbPath: env.dbPath,
        lockDir: env.lockDir,
        sessionID: SESSION_ID,
        fence: false,
        ownerOnly: false,
        holdMs: HOLD_MS,
        outcomeFile: env.outcomeFile,
      }

      await prepareDb(env.dbPath)
      const results = await Promise.all([
        spawnWorker({ ...base, owner: "A" }),
        spawnWorker({ ...base, owner: "B" }),
      ])
      assertWorkersOk(results, ["A", "B"])

      const db = openDb(env.dbPath)
      const rows = readDrainRows(db)
      const outcomes = await readOutcomes(env.outcomeFile)
      db.close()

      const pair = rows.length === 2 ? overlap(rows[0], rows[1]) : false

      console.log("\n========== NEGATIVE CONTROL (fence OFF) — double-drain recurs ==========")
      console.log(`  drain_log rows : ${rows.length}`)
      console.log(`  rows:\n  ${summarizeRows(rows)}`)
      console.log(`  outcomes       : ${outcomes.map((o) => `${o.owner}=${o.result}`).join(", ")}`)
      console.log(`  CONCURRENT?    : ${pair ? "YES — defect recurs with the fence removed" : "no"}`)
      console.log("=======================================================================\n")

      expect(rows.length).toBe(2)
      expect(rows.map((r) => r.owner).sort()).toEqual(["A", "B"])
      expect(pair).toBe(true)
    } finally {
      await fs.rm(env.tmp, { recursive: true, force: true })
    }
  }, 30_000)
})
