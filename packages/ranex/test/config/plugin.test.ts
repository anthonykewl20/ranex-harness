import fs from "fs/promises"
import os from "os"
import path from "path"
import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Account, AccountID, Info, OrgID } from "@/account/account"
import { Config } from "@/config/config"
import { FormatError } from "@/cli/error"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Config.node))
const itWithOrg = testEffect(
  LayerNode.compile(Config.node, [
    [
      Account.node,
      Layer.mock(Account.Service)({
        active: () =>
          Effect.succeed(
            Option.some(
              new Info({
                id: AccountID.make("account"),
                email: "account@example.com",
                url: "https://console.example.com",
                active_org_id: OrgID.make("org"),
              }),
            ),
          ),
        config: () => Effect.succeed(Option.some({ plugin: ["@example/organization-plugin"] })),
        token: () => Effect.succeed(Option.none()),
      }),
    ],
  ]),
)

function expectRejected(exit: Exit.Exit<unknown, unknown>, entries: readonly unknown[]) {
  if (!Exit.isFailure(exit)) throw new Error("expected external plugin configuration to fail")
  const message = FormatError(Cause.squash(exit.cause))
  expect(message).toContain("External plugins are disabled")
  for (const entry of entries) {
    const name =
      typeof entry === "string"
        ? entry
        : Array.isArray(entry)
          ? String(entry[0])
          : typeof entry === "object" && entry !== null && "package" in entry
            ? String(entry.package)
            : "unknown"
    expect(message).toContain(name)
  }
}

it.instance(
  "rejects file, URL, tuple, and npm plugins from project config",
  () =>
    Effect.gen(function* () {
      const entries = ["file:///tmp/plugin.ts", "https://plugins.example/plugin.ts", ["@example/plugin", { enabled: true }]]
      expectRejected(yield* Effect.exit(Config.use.get()), entries)
    }),
  { config: { plugin: ["file:///tmp/plugin.ts", "https://plugins.example/plugin.ts", ["@example/plugin", { enabled: true }]] } },
)

it.instance("rejects plugins from RANEX_CONFIG_CONTENT", () =>
  Effect.gen(function* () {
    const entries = ["file:///tmp/content-plugin.ts", ["@example/content-plugin", { enabled: true }]]
    const previous = process.env.RANEX_CONFIG_CONTENT
    process.env.RANEX_CONFIG_CONTENT = JSON.stringify({ plugin: entries })
    try {
      expectRejected(yield* Effect.exit(Config.use.get()), entries)
    } finally {
      if (previous === undefined) delete process.env.RANEX_CONFIG_CONTENT
      else process.env.RANEX_CONFIG_CONTENT = previous
    }
  }),
)

itWithOrg.instance("rejects plugins from active organization config", () =>
  Effect.gen(function* () {
    expectRejected(yield* Effect.exit(Config.use.get()), ["@example/organization-plugin"])
  }),
)

test("loads both XDG global and RANEX_CONFIG_DIR configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ranex-config-sources-"))
  const xdg = path.join(root, "xdg")
  const override = path.join(root, "override")
  const directory = path.join(root, "project")
  try {
    await Promise.all([
      fs.mkdir(path.join(xdg, "ranex"), { recursive: true }),
      fs.mkdir(override, { recursive: true }),
      fs.mkdir(directory, { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(path.join(xdg, "ranex", "ranex.json"), JSON.stringify({ model: "xdg/model" })),
      fs.writeFile(path.join(override, "ranex.json"), JSON.stringify({ username: "override-user" })),
    ])
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../fixture/config-global-override.ts")], {
      cwd: process.cwd(),
      env: {
        HOME: root,
        XDG_CONFIG_HOME: xdg,
        PATH: process.env.PATH ?? "",
        RANEX_CONFIG_DIR: override,
        TEST_DIRECTORY: directory,
        NODE_ENV: process.env.NODE_ENV ?? "test",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const completed = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = Promise.withResolvers<never>()
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      void child.exited.then(() => timeout.reject(new Error("config child did not exit within 30 seconds")))
    }, 30_000)
    const [exitCode, stdout, stderr] = await Promise.race([completed, timeout.promise]).finally(() => clearTimeout(timer))
    expect(exitCode).toBe(0)
    const result = stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("__RESULT__"))
    if (!result) throw new Error(stderr || "config child did not report a result")
    expect(JSON.parse(result.slice("__RESULT__".length))).toEqual({ model: "xdg/model", username: "override-user" })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("rejects plugins from legacy global TOML", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ranex-legacy-plugin-"))
  const xdg = path.join(root, "xdg")
  try {
    await fs.mkdir(path.join(xdg, "ranex"), { recursive: true })
    await fs.writeFile(path.join(xdg, "ranex", "config"), 'plugin = ["@example/legacy-plugin"]\n')
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../fixture/config-global-plugin.ts")], {
      cwd: process.cwd(),
      env: {
        HOME: root,
        XDG_CONFIG_HOME: xdg,
        PATH: process.env.PATH ?? "",
        NODE_ENV: process.env.NODE_ENV ?? "test",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(stderr || "config child exited unsuccessfully")
    const result = stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("__ERROR__"))
    if (!result) throw new Error(stderr || "config child did not report an error")
    expect(JSON.parse(result.slice("__ERROR__".length))).toMatchObject({
      name: "ConfigInvalidError",
      data: {
        path: path.join(xdg, "ranex", "config"),
        issues: [{ path: ["plugin"], message: expect.stringContaining("@example/legacy-plugin") }],
      },
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

it.instance(
  "accepts absent and empty plugin declarations",
  () =>
    Effect.gen(function* () {
      expect((yield* Config.use.get()).plugin).toEqual([])
    }),
  { config: { plugin: [] } },
)
