import { describe, expect, test } from "bun:test"
import { shouldShareSession } from "@/cli/cmd/github.handler"

describe("github session share", () => {
  test("shares only on explicit opt-in", () => {
    expect(shouldShareSession(true)).toBe(true)
    expect(shouldShareSession(false)).toBe(false)
    expect(shouldShareSession(undefined)).toBe(false)
  })
})
