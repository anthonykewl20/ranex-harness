import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { Parameters as IssueParameters } from "../../src/tool/github/issue"
import { Parameters as MilestoneParameters } from "../../src/tool/github/milestone"
import { Parameters as ProjectParameters } from "../../src/tool/github/project"
import { ToolJsonSchema } from "../../src/tool/json-schema"

const invalidIdentifiers = [0, -1, 1.5, "0", "-1", "1.5", "1e2", "nope"]

describe("github_milestone parameters", () => {
  test.each([
    { action: "list" },
    { action: "get", number: 3 },
    { action: "create", title: "v2", due_on: "2026-09-01T00:00:00Z" },
    { action: "update", number: 3, title: "v2.1", state: "open" },
    { action: "close", number: 3 },
  ])("accepts canonical flat shape %#", (input) => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(MilestoneParameters)(input))).toBe(true)
  })

  test.each(["get", "update", "close"] as const)("coerces numeric string for %s", (action) => {
    const decoded = Schema.decodeUnknownSync(MilestoneParameters)({ action, number: "3" })
    expect("number" in decoded && decoded.number).toBe(3)
  })

  test.each(invalidIdentifiers)("rejects invalid number %p", (number) => {
    expect(Result.isFailure(Schema.decodeUnknownResult(MilestoneParameters)({ action: "get", number }))).toBe(true)
  })

  test("rejects due_on without an ISO 8601 timestamp", () => {
    expect(
      Result.isFailure(Schema.decodeUnknownResult(MilestoneParameters)({ action: "create", title: "v2", due_on: "2026-09-01" })),
    ).toBe(true)
  })

  test("rejects old nested shape and generates JSON Schema", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(MilestoneParameters)({ operation: { action: "list" } }))).toBe(true)
    const json = JSON.stringify(ToolJsonSchema.fromSchema(MilestoneParameters))
    expect(json).toContain('"action"')
    expect(json).toContain('"type":"integer"')
    expect(json).toContain('"type":"string"')
  })
})

describe("github_project parameters", () => {
  test.each([
    { action: "list", owner: "acme" },
    { action: "get", owner: "acme", number: 7 },
    { action: "create", owner: "acme", title: "Roadmap" },
    { action: "add_item", owner: "acme", number: 7, content: { owner: "acme", repo: "app", number: 42 } },
    {
      action: "set_field",
      owner: "acme",
      number: 7,
      field_name: "Status",
      value: "Done",
      content: { owner: "acme", repo: "app", number: 42 },
    },
  ])("accepts canonical flat shape %#", (input) => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(ProjectParameters)(input))).toBe(true)
  })

  test("coerces project and content issue numeric strings", () => {
    const decoded = Schema.decodeUnknownSync(ProjectParameters)({
      action: "add_item",
      owner: "acme",
      number: "7",
      content: { owner: "acme", repo: "app", number: "42" },
    })
    expect("number" in decoded && decoded.number).toBe(7)
    expect("content" in decoded && decoded.content.number).toBe(42)
  })

  test.each(invalidIdentifiers)("rejects invalid project and content number %p", (number) => {
    expect(Result.isFailure(Schema.decodeUnknownResult(ProjectParameters)({ action: "get", owner: "acme", number }))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ProjectParameters)({
          action: "add_item",
          owner: "acme",
          number: 7,
          content: { owner: "acme", repo: "app", number },
        }),
      ),
    ).toBe(true)
  })

  test("rejects old nested shape and generates JSON Schema", () => {
    expect(
      Result.isFailure(Schema.decodeUnknownResult(ProjectParameters)({ operation: { action: "list", owner: "acme" } })),
    ).toBe(true)
    const json = JSON.stringify(ToolJsonSchema.fromSchema(ProjectParameters))
    expect(json).toContain('"action"')
    expect(json).toContain('"type":"integer"')
    expect(json).toContain('"type":"string"')
  })
})

describe("github tool JSON Schema roots", () => {
  test("all three tools serialize with an object-typed root", () => {
    for (const parameters of [IssueParameters, MilestoneParameters, ProjectParameters]) {
      const schema = ToolJsonSchema.fromSchema(parameters)
      expect(schema.type).toBe("object")
      expect(Array.isArray(schema.anyOf)).toBe(true)
    }
  })

  test("root typing keeps the union and its member constraints intact", () => {
    expect(ToolJsonSchema.fromSchema(IssueParameters)).toMatchObject({
      type: "object",
      anyOf: [
        { type: "object", properties: { action: { enum: ["list"] } } },
        { type: "object", properties: { action: { enum: ["get"] }, number: { anyOf: [{ type: "integer" }, { type: "string" }] } } },
        { type: "object", properties: { action: { enum: ["create"] } } },
        { type: "object", properties: { action: { enum: ["update"] } } },
        { type: "object", properties: { action: { enum: ["close"] } } },
        { type: "object", properties: { action: { enum: ["comment"] } } },
      ],
    })
  })

  test("does not type provably non-object roots as object", () => {
    const union = ToolJsonSchema.fromSchema(Schema.Union([Schema.String, Schema.Number]))
    expect(union.type).toBeUndefined()
    expect(Array.isArray(union.anyOf)).toBe(true)
    expect(ToolJsonSchema.fromSchema(Schema.String).type).toBe("string")
  })
})
