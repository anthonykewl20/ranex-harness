import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { ApiError } from "../../src/github/error"
import { getOidcToken } from "../../src/github/oidc"

const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN

describe.serial("github.oidc", () => {
  afterEach(() => {
    if (requestUrl === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    if (requestUrl !== undefined) process.env.ACTIONS_ID_TOKEN_REQUEST_URL = requestUrl
    if (requestToken === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    if (requestToken !== undefined) process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = requestToken
  })

  test("passes through a resolved OIDC token", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        expect(new URL(request.url).searchParams.get("audience")).toBe("ranex")
        expect(request.headers.get("authorization")).toBe("Bearer request-token")
        return Response.json({ value: "header.payload.signature" })
      },
    })
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `${server.url}oidc?request=1`
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "request-token"
    try {
      expect(await Effect.runPromise(getOidcToken("ranex"))).toBe("header.payload.signature")
    } finally {
      await server.stop()
    }
  })

  test("maps getIDToken rejection to the OIDC permission ApiError", async () => {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    const exit = await Effect.runPromise(getOidcToken("ranex").pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(ApiError)
      expect(String(error)).toContain("id-token: write")
      expect(String(error)).toContain("ACTIONS_ID_TOKEN_REQUEST_URL")
    }
  })
})
