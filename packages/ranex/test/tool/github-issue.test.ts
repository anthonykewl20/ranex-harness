import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { Parameters } from "../../src/tool/github/issue"

const accepts = (input: unknown) => Result.isSuccess(Schema.decodeUnknownResult(Parameters)(input))

describe("github_issue parameters", () => {
  test("decodes a flat create operation", () => {
    expect(Schema.decodeUnknownSync(Parameters)({ action: "create", title: "Bug report", owner: "acme", repo: "app" })).toEqual({
      action: "create",
      title: "Bug report",
      owner: "acme",
      repo: "app",
    })
  })

  test("rejects operation field shapes", () => {
    expect(accepts({ operation: "create", title: "Bug report" })).toBe(false)
    expect(accepts({ operation: { action: "create", title: "Bug report" } })).toBe(false)
  })
})
