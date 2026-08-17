// Subprocess driver for heap.test.ts. Firing real heap snapshots
// (writeHeapSnapshot) inside the shared multi-GB full-suite test process
// segfaults Bun 1.3.14, so every snapshot-writing scenario runs here in a
// fresh, small bun process. Results are printed as `KEY value` marker lines
// on stdout; the parent test asserts on them, the child's exit code, and the
// files it leaves behind.
import fs from "node:fs"
import path from "node:path"
import { Heap } from "@/cli/heap"
import { Global } from "@ranex/core/global"

const GATE = "RANEX_AUTO_HEAP_SNAPSHOT"
const RSS = "RANEX_HEAP_SNAPSHOT_RSS_BYTES"
const INTERVAL = "RANEX_HEAP_SNAPSHOT_INTERVAL_MS"

function heapFiles() {
  return fs
    .readdirSync(Global.Path.log)
    .filter((file) => file.startsWith("heap-"))
    .sort()
}

async function until(timeoutMs: number, probe: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

// The file logger flushes in batches, so the structured log line can land
// after the snapshot itself; wait for it so the parent can rely on it.
function logHas(message: string) {
  return Bun.file(path.join(Global.Path.log, "opencode.log"))
    .text()
    .then((text) => text.includes(message))
    .catch(() => false)
}

// One manual snapshot per invocation; the parent spawns this mode twice with
// the same prefix to pin non-overwrite across child processes.
async function manual() {
  console.log(`PATH ${Heap.snapshot(process.argv[3] ?? "manual-test")}`)
}

async function auto() {
  process.env[GATE] = "1"
  process.env[RSS] = "1"
  process.env[INTERVAL] = "50"

  const before = new Set(heapFiles())
  Heap.start()
  console.log(`RUNNING ${Heap.running() ? 1 : 0}`)

  const fired = await until(30_000, () =>
    heapFiles().some((name) => !before.has(name) && fs.statSync(path.join(Global.Path.log, name)).size > 0),
  )
  // Armed latch: further ticks stay above threshold, but exactly one snapshot.
  await new Promise((resolve) => setTimeout(resolve, 300))
  const added = heapFiles().filter((name) => !before.has(name))
  for (const name of added) console.log(`FILE ${path.join(Global.Path.log, name)}`)
  console.log(`FIRED ${fired ? 1 : 0}`)
  console.log(`COUNT ${added.length}`)
  console.log(`LOGGED ${(await until(10_000, () => logHas("auto heap snapshot triggered"))) ? 1 : 0}`)
  Heap.stop()
}

async function rearm() {
  process.env[GATE] = "1"
  process.env[RSS] = "1"
  process.env[INTERVAL] = "50"

  const before = new Set(heapFiles())
  Heap.start()
  const fired = await until(30_000, () => heapFiles().some((name) => !before.has(name)))

  // The threshold is re-read per tick: raising it above current rss re-arms
  // the watcher under the same start.
  process.env[RSS] = String(Number.MAX_SAFE_INTEGER)
  console.log(`FIRED ${fired ? 1 : 0}`)
  console.log(`REARMED ${(await until(10_000, () => logHas("auto heap snapshot re-armed"))) ? 1 : 0}`)
  Heap.stop()
}

const mode = process.argv[2]
const run = mode === "manual" ? manual : mode === "auto" ? auto : mode === "rearm" ? rearm : undefined
if (run === undefined) {
  console.error(`usage: bun heap-snapshot-driver.ts manual|auto|rearm [prefix]`)
  process.exit(2)
}
// Give piped stdout a moment to flush before the explicit exit (the runtime's
// handles would otherwise keep the child alive).
await run().then(
  async () => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    process.exit(0)
  },
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exit(1)
  },
)
