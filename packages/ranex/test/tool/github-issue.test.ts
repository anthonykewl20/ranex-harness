import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { Parameters } from "../../src/tool/github/issue"
import { ToolJsonSchema } from "../../src/tool/json-schema"

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

  test.each(["get", "update", "close", "comment"] as const)(
    "decodes numeric and string issue numbers for %s",
    (action) => {
      const body = action === "comment" ? { body: "Confirmed" } : {}
      const numeric = Schema.decodeUnknownSync(Parameters)({ action, number: 54, ...body })
      const string = Schema.decodeUnknownSync(Parameters)({ action, number: "54", ...body })

      expect("number" in numeric && numeric.number).toBe(54)
      expect("number" in string && string.number).toBe(54)
    },
  )

  test.each([0, -1, 1.5, "0", "-1", "1.5", "1e2", "not-a-number"])("rejects invalid issue number %p", (number) => {
    expect(accepts({ action: "get", number })).toBe(false)
  })

  test("generates JSON Schema for numeric and string issue numbers", () => {
    const json = JSON.stringify(ToolJsonSchema.fromSchema(Parameters))

    expect(json).toContain('"number":{"anyOf":')
    expect(json).toContain('"type":"integer"')
    expect(json).toContain('"type":"string"')
  })

  test.each([
    { action: "list" },
    { action: "get", number: 1 },
    { action: "create", title: "Bug" },
    { action: "update", number: 1, state: "closed" },
    { action: "close", number: 1 },
    { action: "comment", number: 1, body: "Done" },
  ])("accepts canonical action shape %#", (input) => {
    expect(accepts(input)).toBe(true)
  })

  test("coerces milestone identifiers", () => {
    expect(Schema.decodeUnknownSync(Parameters)({ action: "list", milestone: "3" })).toMatchObject({ milestone: 3 })
    expect(Schema.decodeUnknownSync(Parameters)({ action: "create", title: "Bug", milestone: "3" })).toMatchObject({
      milestone: 3,
    })
  })
})
