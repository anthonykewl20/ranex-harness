import { describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { ServerAuth } from "@ranex/server/auth"

const config = { password: Option.some("secret"), username: "alice" }

describe("@ranex/server ServerAuth.authorized", () => {
  test("accepts correct credentials", () => {
    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
  })

  test("rejects wrong credentials", () => {
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("wrong") }, config)).toBe(false)
    expect(ServerAuth.authorized({ username: "bob", password: Redacted.make("secret") }, config)).toBe(false)
    expect(
      ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, {
        password: Option.none(),
        username: "alice",
      }),
    ).toBe(false)
  })
})
