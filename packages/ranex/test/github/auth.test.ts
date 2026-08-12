import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { resolveToken } from "../../src/github/auth"
import { AuthMissing } from "../../src/github/error"

describe("github.auth.resolveToken", () => {
  const previous = process.env.GITHUB_TOKEN

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.GITHUB_TOKEN
      return
    }
    process.env.GITHUB_TOKEN = previous
  })

  test("returns token when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_test_token_123"

    expect(await Effect.runPromise(resolveToken())).toBe("ghp_test_token_123")
  })

  test("throws AuthMissing when GITHUB_TOKEN is unset", async () => {
    delete process.env.GITHUB_TOKEN
    const exit = await Effect.runPromise(resolveToken().pipe(Effect.exit))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(AuthMissing)
  })

  test("throws AuthMissing when GITHUB_TOKEN is empty", async () => {
    process.env.GITHUB_TOKEN = ""
    const exit = await Effect.runPromise(resolveToken().pipe(Effect.exit))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(AuthMissing)
  })
})
