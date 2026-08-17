import fs from "node:fs"
import path from "path"
import { writeHeapSnapshot } from "node:v8"
import { truthy } from "@ranex/core/flag/flag"
import { Global } from "@ranex/core/global"

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_RSS_BYTES = 2 * 1024 * 1024 * 1024
// Node's setInterval clamps delays above 2^31-1 down to 1ms, so an oversized
// interval must be capped here instead of collapsing into a 1ms loop.
const MAX_INTERVAL_MS = 2_147_483_647

let timer: Timer | undefined
let lock = false
let armed = true

function positiveInt(value: string | undefined, fallback: number) {
  if (value === undefined || !/^\d+$/.test(value)) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function config() {
  return {
    intervalMs: Math.min(positiveInt(process.env.RANEX_HEAP_SNAPSHOT_INTERVAL_MS, DEFAULT_INTERVAL_MS), MAX_INTERVAL_MS),
    rssBytes: positiveInt(process.env.RANEX_HEAP_SNAPSHOT_RSS_BYTES, DEFAULT_RSS_BYTES),
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "")
}

// Atomically claims a fresh snapshot path under the log directory. The file is
// created 0600 — heap snapshots capture in-memory secrets and must never be
// group/world readable — and EEXIST bumps a suffix so no existing file is
// ever overwritten.
export function claim(stem: string) {
  for (let i = 0; ; i++) {
    const file = path.join(Global.Path.log, `${stem}${i === 0 ? "" : `-${i}`}.heapsnapshot`)
    try {
      const fd = fs.openSync(file, "wx", 0o600)
      fs.closeSync(fd)
      return file
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
}

async function log(level: "info" | "warn", message: string, data: Record<string, unknown>) {
  const { Effect } = await import("effect")
  const { AppRuntime } = await import("@/effect/app-runtime")
  const effect = level === "warn" ? Effect.logWarning(message, data) : Effect.logInfo(message, data)
  await AppRuntime.runPromise(effect).catch(() => {})
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// Manual trigger (tui.heapsnapshot / server.heapsnapshot): absolute
// timestamped path under the log directory, never overwriting an existing
// file. Write errors propagate to the caller.
export function snapshot(prefix: string) {
  const rss = process.memoryUsage().rss
  const file = claim(`${prefix}-${process.pid}-${stamp()}`)
  void log("info", "heap snapshot triggered", { prefix, rss, path: file })
  try {
    writeHeapSnapshot(file)
  } catch (error) {
    fs.rmSync(file, { force: true })
    void log("warn", "heap snapshot failed", { prefix, rss, path: file, error: errorMessage(error) })
    throw error
  }
  return file
}

export function start() {
  // The gate is read from the env at call time, not through the module-load
  // constant Flag.RANEX_AUTO_HEAP_SNAPSHOT, so tests and tooling can arm the
  // watcher at runtime.
  if (!truthy("RANEX_AUTO_HEAP_SNAPSHOT")) return
  if (timer) return

  armed = true
  lock = false
  const { intervalMs, rssBytes } = config()
  void log("info", "auto heap snapshot armed", {
    thresholdBytes: rssBytes,
    intervalMs,
    directory: Global.Path.log,
  })

  // The threshold is re-read every tick so it can be retuned without a
  // restart; only the interval is fixed at start time.
  const run = async () => {
    if (lock) return

    const rssBytes = config().rssBytes
    const rss = process.memoryUsage().rss
    if (rss <= rssBytes) {
      if (!armed) {
        armed = true
        await log("info", "auto heap snapshot re-armed", { rss, thresholdBytes: rssBytes })
      }
      return
    }
    if (!armed) return

    lock = true
    armed = false
    let file: string | undefined
    try {
      file = claim(`heap-${process.pid}-${stamp()}`)
      await log("info", "auto heap snapshot triggered", { rss, thresholdBytes: rssBytes, path: file })
      writeHeapSnapshot(file)
    } catch (error) {
      if (file) fs.rmSync(file, { force: true })
      await log("warn", "auto heap snapshot failed", {
        rss,
        thresholdBytes: rssBytes,
        ...(file === undefined ? {} : { path: file }),
        error: errorMessage(error),
      })
    } finally {
      lock = false
    }
  }

  timer = setInterval(() => {
    void run()
  }, intervalMs)
  timer.unref?.()
}

export function stop() {
  if (!timer) return
  clearInterval(timer)
  timer = undefined
}

export function running() {
  return timer !== undefined
}

export * as Heap from "./heap"
