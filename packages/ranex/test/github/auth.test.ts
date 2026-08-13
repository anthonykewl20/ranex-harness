import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { mkdirSync } from "node:fs"
import {
  ghConfigDir,
  isEnterprise,
  resolveHost,
  resolveToken,
  resolveTokenOptional,
} from "../../src/github/auth"
import { AuthMissing } from "../../src/github/error"
import { tmpdir } from "../fixture/fixture"

const keys = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "CODESPACES",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "HOME",
  "PATH",
] as const
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

describe.serial("github.auth", () => {
  beforeEach(() => {
    keys.forEach((key) => delete process.env[key])
    process.env.PATH = ""
  })

  afterEach(() => {
    keys.forEach((key) => {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      if (value !== undefined) process.env[key] = value
    })
  })

  test("resolves and classifies normalized hosts", () => {
    process.env.GH_HOST = "HTTPS://GitHub.Example.COM/"
    expect(resolveHost()).toBe("github.example.com")
    expect(isEnterprise("github.com")).toBe(false)
    expect(isEnterprise("GitHub.Example.com")).toBe(true)
  })

  test("uses gh config directory precedence", () => {
    process.env.HOME = "/home/test"
    expect(ghConfigDir()).toBe("/home/test/.config/gh")
    process.env.XDG_CONFIG_HOME = "/xdg"
    expect(ghConfigDir()).toBe("/xdg/gh")
    process.env.GH_CONFIG_DIR = "/explicit"
    expect(ghConfigDir()).toBe("/explicit")
  })

  test("uses GH_TOKEN before GITHUB_TOKEN for github.com", async () => {
    process.env.GH_TOKEN = "gh-token"
    process.env.GITHUB_TOKEN = "github-token"
    expect(await Effect.runPromise(resolveToken())).toBe("gh-token")
  })

  test("uses GITHUB_TOKEN for github.com when GH_TOKEN is absent", async () => {
    process.env.GITHUB_TOKEN = "github-token"
    expect(await Effect.runPromise(resolveToken())).toBe("github-token")
  })

  test("reads github.com token from hosts.yml before the opencode file", async () => {
    await using tmp = await tmpdir()
    mkdirSync(`${tmp.path}/gh`, { recursive: true })
    mkdirSync(`${tmp.path}/.config/opencode`, { recursive: true })
    await Bun.write(`${tmp.path}/gh/hosts.yml`, "github.com:\n  oauth_token: hosts-token\n")
    await Bun.write(`${tmp.path}/.config/opencode/github-token`, "file-token\n")
    process.env.GH_CONFIG_DIR = `${tmp.path}/gh`
    process.env.HOME = tmp.path
    expect(await Effect.runPromise(resolveToken())).toBe("hosts-token")
  })

  test("keeps the github.com opencode token fallback", async () => {
    await using tmp = await tmpdir()
    mkdirSync(`${tmp.path}/.config/opencode`, { recursive: true })
    await Bun.write(`${tmp.path}/.config/opencode/github-token`, "file-token\n")
    process.env.HOME = tmp.path
    expect(await Effect.runPromise(resolveToken())).toBe("file-token")
  })

  test("uses enterprise env precedence", async () => {
    process.env.GH_ENTERPRISE_TOKEN = "gh-enterprise"
    process.env.GITHUB_ENTERPRISE_TOKEN = "github-enterprise"
    process.env.GITHUB_TOKEN = "codespaces-token"
    process.env.CODESPACES = "true"
    expect(await Effect.runPromise(resolveToken({ host: "github.example.com" }))).toBe("gh-enterprise")
  })

  test("uses GITHUB_TOKEN for an enterprise host in Codespaces", async () => {
    process.env.CODESPACES = "true"
    process.env.GITHUB_TOKEN = "codespaces-token"
    expect(await Effect.runPromise(resolveToken({ host: "ghe.example.com" }))).toBe("codespaces-token")
  })

  test("does not use plain GITHUB_TOKEN for an enterprise host outside Codespaces", async () => {
    await using tmp = await tmpdir()
    process.env.HOME = tmp.path
    process.env.GITHUB_TOKEN = "github-token"
    const exit = await Effect.runPromise(resolveToken({ host: "ghe.example.com" }).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(AuthMissing)
  })

  test("reads enterprise token from hosts.yml", async () => {
    await using tmp = await tmpdir()
    mkdirSync(`${tmp.path}/gh`, { recursive: true })
    await Bun.write(`${tmp.path}/gh/hosts.yml`, "github.example.com:\n  oauth_token: enterprise-token\n")
    process.env.GH_CONFIG_DIR = `${tmp.path}/gh`
    expect(await Effect.runPromise(resolveToken({ host: "github.example.com" }))).toBe("enterprise-token")
  })

  test("reads github.com and enterprise tokens from GH_CONFIG_DIR hosts.yml", async () => {
    await using tmp = await tmpdir()
    mkdirSync(`${tmp.path}/gh`, { recursive: true })
    await Bun.write(
      `${tmp.path}/gh/hosts.yml`,
      "github.com:\n  oauth_token: gho_xyz\nghe.example.com:\n  oauth_token: ghe_xyz\n",
    )
    process.env.GH_CONFIG_DIR = `${tmp.path}/gh`
    process.env.HOME = tmp.path
    expect(await Effect.runPromise(resolveToken({ host: "github.com" }))).toBe("gho_xyz")
    expect(await Effect.runPromise(resolveToken({ host: "ghe.example.com" }))).toBe("ghe_xyz")
  })

  test("does not resolve a token through a hosts.yml prototype key", async () => {
    await using tmp = await tmpdir()
    mkdirSync(`${tmp.path}/gh`, { recursive: true })
    await Bun.write(`${tmp.path}/gh/hosts.yml`, "__proto__:\n  user: crafted\n")
    process.env.GH_CONFIG_DIR = `${tmp.path}/gh`
    process.env.HOME = tmp.path
    const exit = await Effect.runPromise(resolveToken({ host: "constructor" }).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(AuthMissing)
  })

  test("fails with AuthMissing mentioning the host", async () => {
    await using tmp = await tmpdir()
    process.env.HOME = tmp.path
    const exit = await Effect.runPromise(resolveToken({ host: "invalid.example" }).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(AuthMissing)
      expect(String(error)).toContain("invalid.example")
    }
  })

  test("optional resolution returns a present token", async () => {
    process.env.GH_TOKEN = "optional-token"
    expect(await Effect.runPromise(resolveTokenOptional({ host: "github.com" }))).toBe("optional-token")
  })

  test("optional resolution returns null for AuthMissing", async () => {
    await using tmp = await tmpdir()
    process.env.HOME = tmp.path
    expect(await Effect.runPromise(resolveTokenOptional({ host: "invalid.example" }))).toBeNull()
  })
})
