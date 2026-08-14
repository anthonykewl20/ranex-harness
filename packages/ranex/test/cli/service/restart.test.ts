import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const entrypoint = path.resolve(import.meta.dir, "../../../../cli/src/index.ts")
const homes: string[] = []

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map(async (home) => {
      await command(home, ["service", "stop"])
      await rm(home, { force: true, recursive: true })
    }),
  )
})

describe("service restart", () => {
  test("replaces a healthy registered service with a different process", async () => {
    const home = await makeHome()
    expect((await command(home, ["service", "start"])).exitCode).toBe(0)
    const incumbent = await registration(home)

    const result = await command(home, ["service", "restart"])
    expect(result.exitCode).toBe(0)
    const replacement = await registration(home)

    expect(replacement.id).not.toBe(incumbent.id)
    expect(replacement.pid).not.toBe(incumbent.pid)
  }, 30_000)

  test("replaces an unreachable registered process when ownership is verified", async () => {
    const home = await makeHome()
    const incumbent = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1_000)"], { stderr: "ignore", stdout: "ignore" })
    const owner = await ownership(incumbent.pid)
    await writeFile(
      path.join(home, ".local/state/ranex/server.json"),
      JSON.stringify({ id: "unresponsive", version: "local", url: "http://127.0.0.1:1", pid: incumbent.pid, ownership: owner }),
    )

    const result = await command(home, ["service", "restart"])
    expect(result.exitCode).toBe(0)
    const replacement = await registration(home)

    expect(replacement.id).not.toBe("unresponsive")
    expect(replacement.pid).not.toBe(incumbent.pid)
    expect(isRunning(incumbent.pid)).toBe(false)
  }, 30_000)

  test("refuses to start when an unreachable incumbent cannot be proven", async () => {
    const home = await makeHome()
    const incumbent = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1_000)"], { stderr: "ignore", stdout: "ignore" })
    await writeFile(
      path.join(home, ".local/state/ranex/server.json"),
      JSON.stringify({ id: "unverified", version: "local", url: "http://127.0.0.1:1", pid: incumbent.pid }),
    )

    const result = await command(home, ["service", "restart"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr + result.stdout).toContain(`registered process ${incumbent.pid}`)
    expect((await registration(home)).id).toBe("unverified")

    incumbent.kill()
  }, 30_000)

  test("refuses to replace a registered process whose ownership changes after SIGTERM", async () => {
    const home = await makeHome()
    const parent = Bun.spawn(
      [
        "python3",
        "-c",
        [
          "import os, signal, time",
          "signal.signal(signal.SIGCHLD, lambda *_: None)",
          "pid = os.fork()",
          "if pid == 0:",
          "    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))",
          "    while True: time.sleep(1)",
          "print(pid, flush=True)",
          "time.sleep(30)",
        ].join("\n"),
      ],
      { stderr: "ignore", stdout: "pipe" },
    )
    const first = await parent.stdout.getReader().read()
    const incumbent = Number(new TextDecoder().decode(first.value).trim())
    const owner = await ownership(incumbent)
    await writeFile(
      path.join(home, ".local/state/ranex/server.json"),
      JSON.stringify({ id: "stuck", version: "local", url: "http://127.0.0.1:1", pid: incumbent, ownership: owner }),
    )

    const result = await command(home, ["service", "restart"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr + result.stdout).toContain(
      `Cannot restart service: registered process ${incumbent} did not exit within 5 seconds after SIGTERM and its ownership changed. Inspect the process before retrying.`,
    )
    expect((await registration(home)).id).toBe("stuck")

    parent.kill()
  }, 30_000)

  test("replaces a registered process that requires SIGKILL", async () => {
    const home = await makeHome()
    const parent = Bun.spawn(
      [
        "python3",
        "-c",
        [
          "import os, signal, time",
          "pid = os.fork()",
          "if pid == 0:",
          "    signal.signal(signal.SIGTERM, lambda *_: None)",
          "    while True: time.sleep(1)",
          "print(pid, flush=True)",
          "while True:",
          "    try:",
          "        if os.waitpid(pid, os.WNOHANG)[0] == pid: break",
          "    except ChildProcessError: break",
          "    time.sleep(0.05)",
        ].join("\n"),
      ],
      { stderr: "ignore", stdout: "pipe" },
    )
    const first = await parent.stdout.getReader().read()
    const incumbent = Number(new TextDecoder().decode(first.value).trim())
    const owner = await ownership(incumbent)
    await writeFile(
      path.join(home, ".local/state/ranex/server.json"),
      JSON.stringify({ id: "term-resistant", version: "local", url: "http://127.0.0.1:1", pid: incumbent, ownership: owner }),
    )

    const result = await command(home, ["service", "restart"])
    expect(result.exitCode).toBe(0)
    const replacement = await registration(home)

    expect(replacement.id).not.toBe("term-resistant")
    expect(replacement.pid).not.toBe(incumbent)
    expect(isRunning(incumbent)).toBe(false)

    parent.kill()
  }, 30_000)
})

async function makeHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "ranex-service-restart-"))
  homes.push(home)
  await mkdir(path.join(home, ".local/state/ranex"), { recursive: true })
  await Bun.write(path.join(home, ".local/state/ranex/password"), "test-password")
  return home
}

async function command(home: string, args: string[]) {
  const child = Bun.spawn(["bun", "run", "--conditions=browser", entrypoint, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      RANEX_CONFIG_CONTENT: "{}",
      RANEX_DISABLE_AUTOUPDATE: "1",
      RANEX_DISABLE_PROJECT_CONFIG: "1",
      RANEX_PURE: "1",
      RANEX_TEST_HOME: home,
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  return {
    exitCode: await child.exited,
    stderr: await new Response(child.stderr).text(),
    stdout: await new Response(child.stdout).text(),
  }
}

async function registration(home: string): Promise<{ id: string; pid: number }> {
  const file = path.join(home, ".local/state/ranex/server.json")
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return JSON.parse(await readFile(file, "utf8"))
    } catch {
      await Bun.sleep(50)
    }
  }
  throw new Error("Timed out waiting for service registration")
}

async function ownership(pid: number) {
  const stat = await Bun.file(`/proc/${pid}/stat`).text()
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)
  return { pid, executable: await readlink(`/proc/${pid}/exe`), starttime: fields[19] }
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
