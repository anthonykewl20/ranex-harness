export * as Sqlite from "./sqlite"

import { chmodSync, existsSync } from "node:fs"
import { Context } from "effect"
import type { drizzle } from "drizzle-orm/bun-sqlite"

export type DrizzleClient = ReturnType<typeof drizzle>
export class Native extends Context.Service<Native, unknown>()("@ranex/core/database/SqliteNative") {}
export class Drizzle extends Context.Service<Drizzle, DrizzleClient>()("@ranex/core/database/SqliteDrizzle") {}

/**
 * Restrict a database opened for write access to the owning user. Databases
 * hold session transcripts and credentials, so the main file plus any existing
 * WAL/SHM siblings must not stay world- or group-readable.
 */
export function restrictToFileOwner(filename: string) {
  if (filename === ":memory:" || filename === "") return
  chmodSync(filename, 0o600)
  for (const suffix of ["-wal", "-shm"]) {
    const sibling = `${filename}${suffix}`
    if (existsSync(sibling)) chmodSync(sibling, 0o600)
  }
}
