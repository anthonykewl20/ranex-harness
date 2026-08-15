import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ensureAuthenticatedBind } from "./serve"

describe("serve bind guard", () => {
  test("allows loopback binds without a password", () => {
    for (const hostname of ["127.0.0.1", "localhost", "::1", "[::1]", "127.5.6.7", "LOCALHOST"]) {
      expect(Effect.runSync(ensureAuthenticatedBind(hostname, ""))).toBeUndefined()
    }
  })

  test("allows non-loopback binds when authentication is configured", () => {
    for (const hostname of ["0.0.0.0", "192.168.1.10", "example.com", "[::]"]) {
      expect(Effect.runSync(ensureAuthenticatedBind(hostname, "secret"))).toBeUndefined()
    }
  })

  test("refuses non-loopback binds without authentication", () => {
    for (const hostname of ["0.0.0.0", "192.168.1.10", "example.com", "::", "10.0.0.5"]) {
      expect(() => Effect.runSync(ensureAuthenticatedBind(hostname, ""))).toThrow(/Refusing to listen on /)
    }
  })
})
