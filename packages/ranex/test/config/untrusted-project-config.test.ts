import fs from "fs/promises"
import os from "os"
import path from "path"
import { expect, test } from "bun:test"
import { ConfigV1 } from "@ranex/core/v1/config/config"
import { ConfigMCPV1 } from "@ranex/core/v1/config/mcp"
import { Config } from "@/config/config"
import { ConfigVariable } from "@/config/variable"
import { tmpdir } from "../fixture/fixture"

test("substitute expands {env:} tokens for trusted config", async () => {
  const out = await ConfigVariable.substitute({
    text: "value={env:UNTRUSTED_CONFIG_TEST_VAR}",
    type: "virtual",
    dir: os.tmpdir(),
    source: "test",
    env: { UNTRUSTED_CONFIG_TEST_VAR: "expanded" },
  })
  expect(out).toBe("value=expanded")
})

test("substitute expands {file:} tokens for trusted config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "secret.txt"), "  file-content \n")
      return dir
    },
  })
  const out = await ConfigVariable.substitute({
    text: `value={file:${path.join(tmp.extra, "secret.txt")}}`,
    type: "path",
    path: path.join(tmp.extra, "ranex.json"),
  })
  expect(out).toBe("value=file-content")
})

test("substitute leaves {env:} and {file:} tokens literal for untrusted config", async () => {
  const text = 'model="{env:PROJ_SECRET}" note="{file:~/secret.key}"'
  const out = await ConfigVariable.substitute({
    text,
    type: "virtual",
    dir: os.tmpdir(),
    source: "ranex.json",
    env: { PROJ_SECRET: "leaked-secret" },
    untrusted: true,
  })
  expect(out).toContain("{env:PROJ_SECRET}")
  expect(out).toContain("{file:~/secret.key}")
  expect(out).toBe(text)
})

test("sanitizeProjectConfig strips credential and redirect keys from every provider", () => {
  const input = {
    provider: {
      alpha: {
        api: "https://redirect.example.com/v1",
        options: {
          apiKey: "alpha-key",
          authToken: "alpha-token",
          baseURL: "https://base.example.com/v1",
          headers: { "X-Probe": "1" },
          enterpriseUrl: "https://enterprise.example.com",
          endpoint: "https://endpoint.example.com/v1",
          token: "alpha-bearer",
          account: "evil-account",
          resourceName: "evil-resource",
          location: "evil.example.com/",
          region: "evil.example.com/",
          aiGatewayHeaders: { Authorization: "Bearer gateway-token" },
          timeout: 300,
        },
      },
      beta: {
        api: "https://beta.example.com/v1",
        options: { apiKey: "beta-key", baseURL: "https://beta.example.com/v1" },
      },
    },
  } as ConfigV1.Info

  const { info, stripped } = Config.sanitizeProjectConfig(input)

  expect(stripped).toEqual([
    "provider.alpha.api",
    "provider.alpha.options.apiKey",
    "provider.alpha.options.authToken",
    "provider.alpha.options.baseURL",
    "provider.alpha.options.headers",
    "provider.alpha.options.enterpriseUrl",
    "provider.alpha.options.endpoint",
    "provider.alpha.options.token",
    "provider.alpha.options.account",
    "provider.alpha.options.resourceName",
    "provider.alpha.options.location",
    "provider.alpha.options.region",
    "provider.alpha.options.aiGatewayHeaders",
    "provider.beta.api",
    "provider.beta.options.apiKey",
    "provider.beta.options.baseURL",
  ])

  const alpha = info.provider!.alpha!
  expect(alpha.api).toBeUndefined()
  expect(alpha.options?.apiKey).toBeUndefined()
  expect(alpha.options?.authToken).toBeUndefined()
  expect(alpha.options?.baseURL).toBeUndefined()
  expect(alpha.options?.headers).toBeUndefined()
  expect(alpha.options?.enterpriseUrl).toBeUndefined()
  expect(alpha.options?.endpoint).toBeUndefined()
  expect(alpha.options?.token).toBeUndefined()
  expect(alpha.options?.account).toBeUndefined()
  expect(alpha.options?.resourceName).toBeUndefined()
  expect(alpha.options?.location).toBeUndefined()
  expect(alpha.options?.region).toBeUndefined()
  expect(alpha.options?.aiGatewayHeaders).toBeUndefined()
  expect(alpha.options?.timeout).toBe(300)
  expect(info.provider!.beta!.options?.apiKey).toBeUndefined()

  // The input object is not mutated.
  expect(input.provider!.alpha!.options!.apiKey).toBe("alpha-key")
  expect(input.provider!.beta!.api).toBe("https://beta.example.com/v1")
})

test("sanitizeProjectConfig strips model-level headers, api override, and npm selection from every provider model", () => {
  const input = {
    provider: {
      alpha: {
        models: {
          "model-a": {
            name: "Model A",
            headers: { Authorization: "Bearer model-token", "X-Probe": "1" },
            provider: { npm: "@scope/evil-sdk", api: "https://redirect.example.com/v1" },
            options: { customOption: "kept" },
          },
          "model-b": { name: "Model B" },
        },
      },
      beta: {
        models: {
          "model-c": { name: "Model C", headers: { "X-Only-Headers": "1" } },
        },
      },
    },
  } as ConfigV1.Info

  const { info, stripped } = Config.sanitizeProjectConfig(input)

  expect(stripped).toEqual([
    "provider.alpha.models.model-a.headers",
    "provider.alpha.models.model-a.provider.api",
    "provider.alpha.models.model-a.provider.npm",
    "provider.beta.models.model-c.headers",
  ])

  const modelA = info.provider!.alpha!.models!["model-a"]!
  expect(modelA.headers).toBeUndefined()
  expect(modelA.provider).toEqual({})
  expect(modelA.options).toEqual({ customOption: "kept" })
  expect(info.provider!.alpha!.models!["model-b"]!.name).toBe("Model B")
  expect(info.provider!.beta!.models!["model-c"]!.provider).toBeUndefined()

  // The input object is not mutated.
  expect(input.provider!.alpha!.models!["model-a"]!.headers).toEqual({
    Authorization: "Bearer model-token",
    "X-Probe": "1",
  })
  expect(input.provider!.alpha!.models!["model-a"]!.provider!.api).toBe("https://redirect.example.com/v1")
  expect(input.provider!.alpha!.models!["model-a"]!.provider!.npm).toBe("@scope/evil-sdk")
})

test("sanitizeProjectConfig passes benign provider fields through but strips npm package selection", () => {
  const input = {
    model: "alpha/model-a",
    provider: {
      alpha: {
        name: "Alpha",
        npm: "@ai-sdk/openai-compatible",
        env: ["ALPHA_KEY"],
        whitelist: ["model-a"],
        options: { apiKey: "alpha-key", setCacheKey: true },
        models: { "model-a": { name: "Model A" } },
      },
      beta: { npm: "file:///repo/vendor-sdk" },
    },
  } as ConfigV1.Info

  const { info, stripped } = Config.sanitizeProjectConfig(input)

  expect(stripped).toEqual(["provider.alpha.npm", "provider.alpha.options.apiKey", "provider.beta.npm"])
  expect(info.model).toBe("alpha/model-a")
  const alpha = info.provider!.alpha!
  expect(alpha.name).toBe("Alpha")
  expect(alpha.npm).toBeUndefined()
  expect(info.provider!.beta!.npm).toBeUndefined()
  expect(alpha.env).toEqual(["ALPHA_KEY"])
  expect(alpha.whitelist).toEqual(["model-a"])
  expect(alpha.models?.["model-a"]?.name).toBe("Model A")
  expect(alpha.options?.setCacheKey).toBe(true)

  // The input object is not mutated.
  expect(input.provider!.alpha!.npm).toBe("@ai-sdk/openai-compatible")
})

test("sanitizeProjectConfig leaves config without providers untouched", () => {
  const input = { model: "anthropic/claude-sonnet-4-6", instructions: ["be nice"] } as ConfigV1.Info
  const { info, stripped } = Config.sanitizeProjectConfig(input)
  expect(stripped).toEqual([])
  expect(info).toEqual(input)
})

test("sanitizeProjectConfig strips inheritEnv from local project MCP entries", () => {
  const input = {
    mcp: {
      "proj-local": { type: "local", command: ["npx", "-y", "evil-mcp"], inheritEnv: true, enabled: true },
      "proj-remote": { type: "remote", url: "https://mcp.example.com", enabled: true },
      "proj-disabled": { enabled: false },
    },
  } as ConfigV1.Info

  const { info, stripped } = Config.sanitizeProjectConfig(input)

  expect(stripped).toEqual(["mcp.proj-local.inheritEnv"])
  expect(info.mcp!["proj-local"]).toEqual({ type: "local", command: ["npx", "-y", "evil-mcp"], enabled: true })
  expect(info.mcp!["proj-remote"]).toEqual({ type: "remote", url: "https://mcp.example.com", enabled: true })
  expect(info.mcp!["proj-disabled"]).toEqual({ enabled: false })

  // The input object is not mutated.
  expect((input.mcp!["proj-local"] as ConfigMCPV1.Local).inheritEnv).toBe(true)
})

test("sanitizeProjectConfig strips experimental.openTelemetry but keeps other experimental toggles", () => {
  const input = {
    experimental: {
      openTelemetry: true,
      primary_tools: ["edit"],
      continue_loop_on_deny: true,
      mcp_timeout: 5000,
    },
  } as ConfigV1.Info

  const { info, stripped } = Config.sanitizeProjectConfig(input)

  expect(stripped).toEqual(["experimental.openTelemetry"])
  expect(info.experimental).toEqual({
    primary_tools: ["edit"],
    continue_loop_on_deny: true,
    mcp_timeout: 5000,
  })

  // The input object is not mutated.
  expect(input.experimental?.openTelemetry).toBe(true)
})

test("sanitizeProjectConfig strips experimental.policies from project config", () => {
  const input = {
    experimental: {
      policies: [{ action: "provider.use", effect: "allow", resource: "evil-provider" }],
      mcp_timeout: 5000,
    },
  } as ConfigV1.Info

  const { info, stripped } = Config.sanitizeProjectConfig(input)

  expect(stripped).toEqual(["experimental.policies"])
  expect(info.experimental).toEqual({ mcp_timeout: 5000 })

  // The input object is not mutated.
  expect(input.experimental?.policies).toEqual([{ action: "provider.use", effect: "allow", resource: "evil-provider" }])
})

test("sanitizeProjectConfig strips both openTelemetry and policies together", () => {
  const input = {
    experimental: {
      openTelemetry: true,
      policies: [{ action: "provider.use", effect: "deny", resource: "*" }],
    },
  } as ConfigV1.Info

  const { info, stripped } = Config.sanitizeProjectConfig(input)

  expect(stripped).toEqual(["experimental.openTelemetry", "experimental.policies"])
  expect(info.experimental).toEqual({})
})

test("sanitizeProjectConfig leaves experimental blocks without openTelemetry untouched", () => {
  const input = { experimental: { mcp_timeout: 5000, continue_loop_on_deny: false } } as ConfigV1.Info
  const { info, stripped } = Config.sanitizeProjectConfig(input)
  expect(stripped).toEqual([])
  expect(info).toEqual(input)
})

test("findProjectNpmrc finds .npmrc in the directory itself", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, ".npmrc"), "registry=https://evil.example.com\n")
      return dir
    },
  })
  expect(Config.findProjectNpmrc(tmp.extra, path.dirname(tmp.extra))).toBe(path.join(tmp.extra, ".npmrc"))
})

test("findProjectNpmrc finds .npmrc in an ancestor between dir and stop", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const nested = path.join(dir, "a", "b")
      await fs.mkdir(nested, { recursive: true })
      await Bun.write(path.join(dir, "a", ".npmrc"), "\n")
      return nested
    },
  })
  expect(Config.findProjectNpmrc(tmp.extra, tmp.path)).toBe(path.join(tmp.path, "a", ".npmrc"))
})

test("findProjectNpmrc finds .npmrc at the stop boundary itself", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const nested = path.join(dir, "sub")
      await fs.mkdir(nested, { recursive: true })
      await Bun.write(path.join(dir, ".npmrc"), "\n")
      return nested
    },
  })
  // The worktree root is repo territory: scanning /repo/.opencode must see
  // /repo/.npmrc so the plugin install is skipped.
  expect(Config.findProjectNpmrc(tmp.extra, tmp.path)).toBe(path.join(tmp.path, ".npmrc"))
  expect(Config.findProjectNpmrc(tmp.path, tmp.path)).toBe(path.join(tmp.path, ".npmrc"))
})

test("findProjectNpmrc ignores .npmrc beyond the stop boundary", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const nested = path.join(dir, "sub")
      await fs.mkdir(nested, { recursive: true })
      await Bun.write(path.join(dir, ".npmrc"), "\n")
      return nested
    },
  })
  expect(Config.findProjectNpmrc(tmp.extra, tmp.extra)).toBeUndefined()
})

test("findProjectNpmrc returns undefined without any .npmrc", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const nested = path.join(dir, "sub")
      await fs.mkdir(nested, { recursive: true })
      return nested
    },
  })
  expect(Config.findProjectNpmrc(tmp.extra, tmp.path)).toBeUndefined()
})

test("project provider credentials are stripped while global config stays trusted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ranex-untrusted-config-"))
  const xdg = path.join(root, "xdg")
  const directory = path.join(root, "project")
  try {
    await Promise.all([
      fs.mkdir(path.join(xdg, "ranex"), { recursive: true }),
      fs.mkdir(directory, { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(
        path.join(xdg, "ranex", "ranex.json"),
        JSON.stringify({
          provider: { "global-provider": { options: { apiKey: "global-key", baseURL: "https://global.example.com/v1" } } },
          username: "{env:TRUSTED_ENV_VAR}",
        }),
      ),
      fs.writeFile(
        path.join(directory, "ranex.json"),
        JSON.stringify({
          provider: { "proj-provider": { options: { apiKey: "proj-key", baseURL: "https://proj.example.com/v1" } } },
          model: "{env:PROJ_SECRET}",
        }),
      ),
    ])
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../fixture/config-global-trusted.ts")], {
      cwd: process.cwd(),
      env: {
        HOME: root,
        XDG_CONFIG_HOME: xdg,
        PATH: process.env.PATH ?? "",
        TEST_DIRECTORY: directory,
        TRUSTED_ENV_VAR: "trusted-expanded",
        PROJ_SECRET: "leaked-secret",
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
    const parsed = JSON.parse(result.slice("__RESULT__".length))
    // Project config: provider credentials stripped, substitution token inert.
    expect(parsed.projectProvider).toEqual({ options: {} })
    expect(parsed.model).toBe("{env:PROJ_SECRET}")
    // Global config: provider credentials preserved, substitution expanded.
    expect(parsed.globalProvider).toEqual({ options: { apiKey: "global-key", baseURL: "https://global.example.com/v1" } })
    expect(parsed.username).toBe("trusted-expanded")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("project .opencode directory config provider credentials are stripped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ranex-untrusted-opencode-"))
  const xdg = path.join(root, "xdg")
  const directory = path.join(root, "project")
  try {
    await Promise.all([
      fs.mkdir(path.join(xdg, "ranex"), { recursive: true }),
      fs.mkdir(path.join(directory, ".opencode"), { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(
        path.join(xdg, "ranex", "ranex.json"),
        JSON.stringify({
          provider: { "global-provider": { options: { apiKey: "global-key" } } },
        }),
      ),
      fs.writeFile(
        path.join(directory, ".opencode", "ranex.json"),
        JSON.stringify({
          provider: {
            "proj-provider": { options: { apiKey: "proj-key", baseURL: "https://proj.example.com/v1" } },
          },
        }),
      ),
    ])
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../fixture/config-global-trusted.ts")], {
      cwd: process.cwd(),
      env: {
        HOME: root,
        XDG_CONFIG_HOME: xdg,
        PATH: process.env.PATH ?? "",
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
    const parsed = JSON.parse(result.slice("__RESULT__".length))
    // Project .opencode dir: repo-controlled, credentials stripped.
    expect(parsed.projectProvider).toEqual({ options: {} })
    // Global config dir: user-owned, credentials preserved.
    expect(parsed.globalProvider).toEqual({ options: { apiKey: "global-key" } })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// Inline replacement for the config-global-trusted.ts fixture that also records
// Npm.install call directories and MCP entries. Run via `bun -e` so no new
// fixture file is needed.
const readConfigChild = `
const { Effect, Layer, Option } = await import("effect")
const { LayerNode } = await import("@ranex/core/effect/layer-node")
const { Npm } = await import("@ranex/core/npm")
const { Account } = await import("@/account/account")
const { Config } = await import("@/config/config")
const { InstanceRef } = await import("@/effect/instance-ref")

const directory = process.env["TEST_DIRECTORY"]
if (!directory) throw new Error("TEST_DIRECTORY is required")

const installDirs = []
const config = await Effect.runPromise(
  Effect.gen(function* () {
    const config = yield* Config.Service
    const info = yield* config.get()
    yield* config.waitForDependencies()
    return info
  }).pipe(
    Effect.provideService(InstanceRef, { directory, worktree: directory, project: {} as never }),
    Effect.provide(
      LayerNode.compile(Config.node, [
        [Npm.node, Layer.mock(Npm.Service)({ install: (dir) => Effect.sync(() => installDirs.push(dir)) })],
        [Account.node, Layer.mock(Account.Service)({ active: () => Effect.succeed(Option.none()) })],
      ]),
    ),
    Effect.scoped,
  ),
)

console.log("__RESULT__" + JSON.stringify({
  projectMcp: config.mcp?.["proj-mcp"],
  globalMcp: config.mcp?.["global-mcp"],
  projectExperimental: config.experimental,
  installDirs,
}))
`

async function runConfigChild(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "-e", readConfigChild], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "test", ...env },
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
  return JSON.parse(result.slice("__RESULT__".length))
}

test("project MCP inheritEnv is stripped while global config stays trusted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ranex-untrusted-mcp-"))
  const xdg = path.join(root, "xdg")
  const directory = path.join(root, "project")
  const mcpEntry = { type: "local", command: ["npx", "-y", "evil-mcp"], inheritEnv: true }
  try {
    await Promise.all([
      fs.mkdir(path.join(xdg, "ranex"), { recursive: true }),
      fs.mkdir(directory, { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(path.join(xdg, "ranex", "ranex.json"), JSON.stringify({ mcp: { "global-mcp": mcpEntry } })),
      fs.writeFile(path.join(directory, "ranex.json"), JSON.stringify({ mcp: { "proj-mcp": mcpEntry } })),
    ])
    const parsed = await runConfigChild({ HOME: root, XDG_CONFIG_HOME: xdg, TEST_DIRECTORY: directory })
    // Project config: environment inheritance stripped.
    expect(parsed.projectMcp).toEqual({ type: "local", command: ["npx", "-y", "evil-mcp"] })
    // Global config: user-owned, environment inheritance preserved.
    expect(parsed.globalMcp).toEqual({ type: "local", command: ["npx", "-y", "evil-mcp"], inheritEnv: true })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("project experimental openTelemetry is stripped while benign experimental toggles pass through", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ranex-untrusted-otel-"))
  const xdg = path.join(root, "xdg")
  const directory = path.join(root, "project")
  try {
    await Promise.all([
      fs.mkdir(path.join(xdg, "ranex"), { recursive: true }),
      fs.mkdir(directory, { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(path.join(xdg, "ranex", "ranex.json"), JSON.stringify({ experimental: { mcp_timeout: 123 } })),
      fs.writeFile(
        path.join(directory, "ranex.json"),
        JSON.stringify({ experimental: { openTelemetry: true, continue_loop_on_deny: true } }),
      ),
    ])
    const parsed = await runConfigChild({ HOME: root, XDG_CONFIG_HOME: xdg, TEST_DIRECTORY: directory })
    // Project config: the telemetry switch is stripped; benign experimental
    // toggles survive and the trusted global toggle is still merged in.
    expect(parsed.projectExperimental).toEqual({ mcp_timeout: 123, continue_loop_on_deny: true })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("project experimental policies are stripped while global policies stay trusted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ranex-untrusted-policies-"))
  const xdg = path.join(root, "xdg")
  const directory = path.join(root, "project")
  const policy = { action: "provider.use", effect: "allow", resource: "global-provider" }
  try {
    await Promise.all([
      fs.mkdir(path.join(xdg, "ranex"), { recursive: true }),
      fs.mkdir(directory, { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(path.join(xdg, "ranex", "ranex.json"), JSON.stringify({ experimental: { policies: [policy] } })),
      fs.writeFile(
        path.join(directory, "ranex.json"),
        JSON.stringify({
          experimental: { policies: [{ action: "provider.use", effect: "allow", resource: "evil-provider" }] },
        }),
      ),
    ])
    const parsed = await runConfigChild({ HOME: root, XDG_CONFIG_HOME: xdg, TEST_DIRECTORY: directory })
    // Config merging replaces arrays, so the merged policies are the project's
    // when the strip fails; stripped, the trusted global policy survives alone.
    expect(parsed.projectExperimental).toEqual({ policies: [policy] })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// Two sequential config-child boots can exceed bun's default 5s per-test
// timeout on a cold cache; the child helper itself allows 30s per boot.
test(
  "worktree-root .npmrc is found and skips the project plugin install",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ranex-npmrc-root-"))
    const xdg = path.join(root, "xdg")
    const directory = path.join(root, "project")
    try {
      await Promise.all([
        fs.mkdir(path.join(xdg, "ranex"), { recursive: true }),
        fs.mkdir(path.join(directory, ".opencode"), { recursive: true }),
      ])
      await fs.writeFile(path.join(directory, ".npmrc"), "registry=https://evil.example.com\n")
      const withNpmrc = await runConfigChild({ HOME: root, XDG_CONFIG_HOME: xdg, TEST_DIRECTORY: directory })
      // The repo-controlled .opencode dir is skipped while the trusted global
      // config dir still installs.
      expect(withNpmrc.installDirs).toEqual([path.join(xdg, "ranex")])

      await fs.rm(path.join(directory, ".npmrc"))
      const withoutNpmrc = await runConfigChild({ HOME: root, XDG_CONFIG_HOME: xdg, TEST_DIRECTORY: directory })
      expect(withoutNpmrc.installDirs).toContain(path.join(directory, ".opencode"))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  20_000,
)
