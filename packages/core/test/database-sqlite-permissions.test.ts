import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { Database } from "bun:sqlite"
import { Effect } from "effect"
import { Sqlite } from "@ranex/core/database/sqlite"
import { layer } from "#sqlite"
import { tmpdir } from "./fixture/tmpdir"

const mode = (file: string) => fs.statSync(file).mode & 0o777

describe("sqlite database file permissions", () => {
  test.skipIf(process.platform === "win32")("restricts the database and existing wal/shm siblings to the owner on open", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    // Simulate a legacy world-readable database left behind with wal/shm siblings.
    fs.writeFileSync(dbPath, "")
    fs.writeFileSync(`${dbPath}-wal`, "")
    fs.writeFileSync(`${dbPath}-shm`, "")
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.chmodSync(file, 0o644)
    expect(mode(dbPath)).toBe(0o644)

    await Effect.runPromise(
      Effect.gen(function* () {
        const native = (yield* Sqlite.Native) as Database
        native.run("create table if not exists t (x)")
        native.run("insert into t values (1)")

        expect(mode(dbPath)).toBe(0o600)
        expect(mode(`${dbPath}-wal`)).toBe(0o600)
        expect(mode(`${dbPath}-shm`)).toBe(0o600)
      }).pipe(Effect.scoped, Effect.provide(layer({ filename: dbPath }))),
    )
  })

  test.skipIf(process.platform === "win32")("opens in-memory databases without touching the filesystem", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const native = (yield* Sqlite.Native) as Database
        native.run("create table if not exists t (x)")
      }).pipe(Effect.scoped, Effect.provide(layer({ filename: ":memory:" }))),
    )
  })
})
