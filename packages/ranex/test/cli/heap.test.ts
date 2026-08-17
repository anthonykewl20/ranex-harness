import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@ranex/core/global"
import { Heap } from "@/cli/heap"

const GATE = "RANEX_AUTO_HEAP_SNAPSHOT"
const RSS = "RANEX_HEAP_SNAPSHOT_RSS_BYTES"
const INTERVAL = "RANEX_HEAP_SNAPSHOT_INTERVAL_MS"

// Real snapshot writes run in child bun processes (see
// heap-snapshot-driver.ts): writeHeapSnapshot inside the shared full-suite
// test process segfaults Bun 1.3.14, while the module itself is correct in a
// fresh process. Pure tests (config parsing, claim, gate-off, EACCES before
// any write) stay in-process.
const driver = path.join(import.meta.dir, "heap-snapshot-driver.ts")

function heapFiles() {
  return fs
    .readdirSync(Global.Path.log)
    .filter((file) => file.startsWith("heap-"))
    .sort()
}

async function logBaseline() {
  return Bun.file(path.join(Global.Path.log, "opencode.log"))
    .text()
    .catch(() => "")
}

// Waits for a new structured log line containing `message` to appear in
// opencode.log after `baseline` (captured before the triggering action). The
// file logger flushes in batches, so entries land asynchronously.
async function nextLogLine(baseline: string, message: string, timeoutMs = 15_000) {
  const file = path.join(Global.Path.log, "opencode.log")
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 100) {
    const text = await Bun.file(file)
      .text()
      .catch(() => "")
    const line = text
      .slice(baseline.length)
      .split("\n")
      .find((entry) => entry.includes(message))
    if (line !== undefined) return line
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for log line: ${message}`)
}

type DriverResult = { exitCode: number; stdout: string; stderr: string }

async function runDriver(mode: string, args: string[] = [], timeoutMs = 120_000): Promise<DriverResult> {
  const child = Bun.spawn(["bun", "run", "--conditions=browser", driver, mode, ...args], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      // Same offline hardening the CLI subprocess fixture uses: the child
      // inherits the parent's XDG_* isolation (so its snapshots and log lines
      // land in the same directories the assertions read) but stays off the
      // network/plugin path.
      RANEX_PURE: "1",
      RANEX_DISABLE_AUTOUPDATE: "1",
      RANEX_DISABLE_MODELS_FETCH: "1",
      RANEX_DISABLE_PROJECT_CONFIG: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const killer = setTimeout(() => child.kill(), timeoutMs)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(killer)
  }
}

function requireMarker(run: DriverResult, key: string) {
  const line = run.stdout.split("\n").find((entry) => entry.startsWith(`${key} `))
  if (line === undefined) {
    throw new Error(`driver printed no ${key} marker\nstdout: ${run.stdout}\nstderr: ${run.stderr}`)
  }
  return line.slice(key.length + 1).trim()
}

afterEach(() => {
  Heap.stop()
  delete process.env[GATE]
  delete process.env[RSS]
  delete process.env[INTERVAL]
  fs.chmodSync(Global.Path.log, 0o700)
})

describe("heap snapshot config", () => {
  test("defaults when env unset or invalid", () => {
    delete process.env[RSS]
    delete process.env[INTERVAL]
    expect(Heap.config()).toEqual({ intervalMs: 60_000, rssBytes: 2 * 1024 * 1024 * 1024 })

    process.env[RSS] = "abc"
    process.env[INTERVAL] = "0"
    expect(Heap.config()).toEqual({ intervalMs: 60_000, rssBytes: 2 * 1024 * 1024 * 1024 })

    process.env[RSS] = "-5"
    process.env[INTERVAL] = "10ms"
    expect(Heap.config()).toEqual({ intervalMs: 60_000, rssBytes: 2 * 1024 * 1024 * 1024 })
  })

  test("env overrides respected", () => {
    process.env[RSS] = "123456789"
    process.env[INTERVAL] = "250"
    expect(Heap.config()).toEqual({ intervalMs: 250, rssBytes: 123456789 })
  })
})

describe("heap snapshot output", () => {
  test("claim never overwrites an existing file and creates 0600", () => {
    const first = path.join(Global.Path.log, "claim-collide.heapsnapshot")
    fs.writeFileSync(first, "original", { mode: 0o600 })
    fs.writeFileSync(path.join(Global.Path.log, "claim-collide-1.heapsnapshot"), "blocked", { mode: 0o600 })

    const claimed = Heap.claim("claim-collide")
    expect(claimed).toBe(path.join(Global.Path.log, "claim-collide-2.heapsnapshot"))
    expect(fs.statSync(claimed).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(first, "utf8")).toBe("original")
  })

  test("manual snapshot writes absolute 0600 files without overwriting", async () => {
    // Two child invocations with the same prefix: each writes one timestamped
    // snapshot, and neither may overwrite the other.
    const runs = [await runDriver("manual", ["manual-test"]), await runDriver("manual", ["manual-test"])]
    const paths = runs.map((run, index) => {
      expect(run.exitCode, `manual run ${index + 1} stderr: ${run.stderr}`).toBe(0)
      return requireMarker(run, "PATH")
    })

    expect(paths[0]).not.toBe(paths[1])
    for (const file of paths) {
      expect(path.isAbsolute(file)).toBe(true)
      expect(path.dirname(file)).toBe(Global.Path.log)
      expect(path.basename(file)).toMatch(/^manual-test-\d+-\d{4}-\d{2}-\d{2}T\d+Z\.heapsnapshot$/)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.statSync(file).size).toBeGreaterThan(0)
    }
  }, 180_000)
})

describe("auto heap snapshot watcher", () => {
  test("no timer when the gate is unset", async () => {
    delete process.env[GATE]
    process.env[INTERVAL] = "20"
    process.env[RSS] = "1"

    const before = heapFiles()
    Heap.start()
    expect(Heap.running()).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(heapFiles()).toEqual(before)
  })

  test("fires once above threshold with 0600 file and log line", async () => {
    const baseline = await logBaseline()
    const run = await runDriver("auto")
    expect(run.exitCode, `auto driver stderr: ${run.stderr}`).toBe(0)
    expect(requireMarker(run, "RUNNING")).toBe("1")
    expect(requireMarker(run, "FIRED")).toBe("1")
    // Armed latch: exactly one snapshot despite further ticks above threshold.
    expect(requireMarker(run, "COUNT")).toBe("1")
    expect(requireMarker(run, "LOGGED")).toBe("1")

    const file = requireMarker(run, "FILE")
    expect(path.isAbsolute(file)).toBe(true)
    expect(path.dirname(file)).toBe(Global.Path.log)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(file).size).toBeGreaterThan(0)

    const line = await nextLogLine(baseline, "auto heap snapshot triggered")
    expect(line).toContain("rss=")
    expect(line).toContain(file)
  }, 180_000)

  // The claim inside run() throws EACCES before writeHeapSnapshot is ever
  // reached, so this failure path stays safely in-process. Skipped as root:
  // root bypasses the chmod-0500 directory permissions (CAP_DAC_OVERRIDE),
  // so claim() would succeed and fire a real writeHeapSnapshot inside this
  // shared test process — the exact crash class this suite avoids.
  test.skipIf(process.getuid?.() === 0)("write failure is logged and non-fatal", async () => {
    process.env[GATE] = "1"
    process.env[RSS] = "1"
    process.env[INTERVAL] = "50"

    // Seed the log file before the directory goes read-only: the file logger
    // appends by path (`flag: "a"`), so with the file already present it
    // needs no directory write permission. Without this the test would depend
    // on an earlier test having created opencode.log.
    await Bun.write(path.join(Global.Path.log, "opencode.log"), "")

    const baseline = await logBaseline()
    Heap.start()
    // A read-only log directory makes the exclusive claim fail with EACCES.
    fs.chmodSync(Global.Path.log, 0o500)

    const line = await nextLogLine(baseline, "auto heap snapshot failed")
    expect(line).toContain("rss=")
    expect(line).toContain("EACCES")

    // The watcher survives the failure.
    expect(Heap.running()).toBe(true)
  }, 30_000)

  test("re-arm is logged when rss falls back below threshold", async () => {
    const baseline = await logBaseline()
    const run = await runDriver("rearm")
    expect(run.exitCode, `rearm driver stderr: ${run.stderr}`).toBe(0)
    expect(requireMarker(run, "FIRED")).toBe("1")
    expect(requireMarker(run, "REARMED")).toBe("1")

    const line = await nextLogLine(baseline, "auto heap snapshot re-armed")
    expect(line).toContain("rss=")
  }, 180_000)
})
