// SLICE-011 claim 5 — worker subprocess. One process = one SessionRunCoordinator
// (the in-memory Map at run-coordinator.ts:28) over the shared SQLite DB.
// Two such workers draining ONE session reproduce the double-drain; the fence
// (EffectFlock keyed on sessionID + event_sequence.owner_id claim/refuse,
// mirroring event.ts:254/274/291/525) refuses the second owner.

import { Database } from "bun:sqlite"
import fs from "fs/promises"
import os from "os"
import { Effect } from "effect"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Global } from "@opencode-ai/core/global"
import type { Outcome } from "./schema"

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

const msg = JSON.parse(process.argv[2]) as Msg

// DB setup. busy_timeout MUST be the first pragma: a journal_mode change needs a
// brief exclusive lock, and with busy_timeout still at its 0 default two workers
// opening the shared DB simultaneously collide with "database is locked" instead
// of waiting. WAL mode and the schema are established once by prepareDb() in the
// orchestrator (WAL is persistent; the tables already exist), so the worker does
// NOT re-run journal_mode or the DDL — re-running journal_mode here is exactly
// what raced concurrent startup. Wrap setup so a failure is a deliberate,
// diagnosable non-zero exit rather than an unhandled throw off the Effect path.
let db: Database
try {
  db = new Database(msg.dbPath, { create: true, readwrite: true })
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA synchronous = NORMAL")
} catch (err) {
  process.stderr.write(
    `[worker owner=${msg.owner}] DB setup failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  )
  process.exit(1)
}

// Atomic claim/refuse mirroring event.ts:325-334 (INSERT ... onConflictDoUpdate):
// a single statement under SQLite's writer lock — no read/then/write window a
// concurrent owner can slip through. On INSERT the claiming owner wins; on
// conflict the existing owner is returned and any different owner is refused.
const claimOrRefuse = (owner: string): { refused: boolean; conflict?: string } => {
  const row = db
    .query(
      `INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, 0, ?)
       ON CONFLICT(aggregate_id) DO UPDATE SET seq = event_sequence.seq
       RETURNING owner_id AS owner_id`,
    )
    .get(msg.sessionID, owner) as { owner_id: string | null }
  if (row.owner_id === owner) return { refused: false }
  return { refused: true, conflict: row.owner_id ?? undefined }
}

const testGlobal = Global.layerWith({
  home: os.homedir(),
  data: os.tmpdir(),
  cache: os.tmpdir(),
  config: os.tmpdir(),
  state: os.tmpdir(),
  bin: os.tmpdir(),
  log: os.tmpdir(),
})
const testLayer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, testGlobal]])

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const fileExists = (p: string) => fs.stat(p).then(() => true).catch(() => false)

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service

      // per-process mutable outcome; the drain writes it, run awaits the drain.
      let outcome: Outcome = {
        owner: msg.owner,
        result: "refused",
        activeBefore: [],
        activeAfter: [],
      }

      const markInDrain = (present: boolean) =>
        msg.inDrainFile
          ? present
            ? Effect.promise(() => fs.writeFile(msg.inDrainFile!, msg.owner))
            : Effect.promise(() => fs.rm(msg.inDrainFile!, { force: true }))
          : Effect.void

      // the provider-turn side effect: one durable drain_log row, held for holdMs.
      const drainWork = Effect.gen(function* () {
        yield* markInDrain(true)
        const started = Date.now()
        db.run("INSERT INTO drain_log (session_id, owner, started_at) VALUES (?, ?, ?)", [msg.sessionID, msg.owner, started])
        yield* Effect.promise(() => sleep(msg.holdMs))
        const ended = Date.now()
        db.run("UPDATE drain_log SET ended_at = ? WHERE rowid = last_insert_rowid()", [ended])
        yield* markInDrain(false)
        outcome = { ...outcome, result: "drained", started, ended }
      })

      // owner_id isolation: the durable claim/refuse transaction ALONE (no flock),
      // so its protective value under true concurrency can be isolated from the
      // flock's cross-process mutex. The transaction is atomic (SQLite writer
      // lock), so two concurrent owners cannot both claim.
      const ownerOnlyDrain = Effect.gen(function* () {
        const decision = claimOrRefuse(msg.owner)
        if (decision.refused) {
          outcome = { ...outcome, result: "refused", conflict: decision.conflict }
          return
        }
        yield* drainWork
      })

      const fencedDrain = flock.withLock(
        Effect.gen(function* () {
          // signal "I hold the flock" for the orchestrator's handshake/sampler
          if (msg.readyFile) yield* Effect.promise(() => fs.writeFile(msg.readyFile!, String(process.pid)))
          const decision = claimOrRefuse(msg.owner)
          if (decision.refused) {
            outcome = { ...outcome, result: "refused", conflict: decision.conflict }
            return
          }
          yield* drainWork
        }),
        msg.sessionID,
        msg.lockDir,
      )

      const coordinator = yield* SessionRunCoordinator.make<string, EffectFlock.LockError>({
        drain: () => (msg.ownerOnly ? ownerOnlyDrain : msg.fence ? fencedDrain : drainWork),
      })

      // handshake: a second owner waits until the first signals it holds the flock.
      if (msg.startAfterFile) {
        while (!(yield* Effect.promise(() => fileExists(msg.startAfterFile!)))) yield* Effect.promise(() => sleep(5))
      }

      outcome.activeBefore = Array.from(yield* coordinator.active)
      yield* coordinator.run(msg.sessionID)
      outcome.activeAfter = Array.from(yield* coordinator.active)
      yield* Effect.promise(() => fs.appendFile(msg.outcomeFile, JSON.stringify(outcome) + "\n"))
    }),
  ).pipe(Effect.provide(testLayer)),
).catch((err) => {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
  process.stderr.write(text)
  process.exit(1)
})

db.close()
process.exit(0)
