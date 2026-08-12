import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { mkdirSync } from "node:fs"
import { resolveToken } from "../../src/github/auth"
import { AuthMissing } from "../../src/github/error"
import { tmpdir } from "../fixture/fixture"

describe.serial("github.auth.resolveToken", () => {
  const previousToken = process.env.GITHUB_TOKEN
  const previousHome = process.env.HOME
  const previousHost = process.env.GH_HOST

  afterEach(() => {
    if (previousToken === undefined) {
      delete process.env.GITHUB_TOKEN
    } else {
      process.env.GITHUB_TOKEN = previousToken
    }

    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }

    if (previousHost === undefined) {
      delete process.env.GH_HOST
    } else {
      process.env.GH_HOST = previousHost
    }
  })

  test("returns token when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_test_token_123"

    expect(await Effect.runPromise(resolveToken())).toBe("ghp_test_token_123")
  })

  test("reads token from file when GITHUB_TOKEN is unset", async () => {
    await using tmp = await tmpdir()
    mkdirSync(`${tmp.path}/.config/opencode`, { recursive: true })
    await Bun.write(`${tmp.path}/.config/opencode/github-token`, "ghp_file_token_456\n")
    delete process.env.GITHUB_TOKEN
    process.env.HOME = tmp.path

    expect(await Effect.runPromise(resolveToken())).toBe("ghp_file_token_456")
  })

  test("throws AuthMissing when GITHUB_TOKEN and token file are absent", async () => {
    await using tmp = await tmpdir()
    delete process.env.GITHUB_TOKEN
    process.env.HOME = tmp.path
    process.env.GH_HOST = "invalid.example"
    const exit = await Effect.runPromise(resolveToken().pipe(Effect.exit))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(AuthMissing)
  })

  test("throws AuthMissing when GITHUB_TOKEN and token file are empty", async () => {
    await using tmp = await tmpdir()
    mkdirSync(`${tmp.path}/.config/opencode`, { recursive: true })
    await Bun.write(`${tmp.path}/.config/opencode/github-token`, "\n")
    process.env.GITHUB_TOKEN = ""
    process.env.HOME = tmp.path
    process.env.GH_HOST = "invalid.example"
    const exit = await Effect.runPromise(resolveToken().pipe(Effect.exit))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(AuthMissing)
  })

  test("falls back to gh auth token when env and file are absent", async () => {
    await using tmp = await tmpdir()
    delete process.env.GITHUB_TOKEN
    process.env.HOME = tmp.path

    const token = await Effect.runPromise(resolveToken())

    expect(token).toMatch(/^(ghp_|gho_|github_pat_)/)
  })
})
