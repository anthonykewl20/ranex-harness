// SLICE-011 claim 5 (ownership fencing) — scratch prototype.
// Mirrors the harness event_sequence schema (schema.gen.ts:73-77) and the
// drain observable. Shared between the worker subprocess and the orchestrator.

export const SESSION_ID = "sess-DOUBLE-DRAIN-fixture"

export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS event_sequence (
    aggregate_id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    owner_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS drain_log (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  )`,
] as const

export type DrainRow = {
  rowid: number
  session_id: string
  owner: string
  started_at: number
  ended_at: number | null
}

export type Outcome = {
  owner: string
  result: "drained" | "refused"
  conflict?: string
  started?: number
  ended?: number
  activeBefore: string[]
  activeAfter: string[]
}
