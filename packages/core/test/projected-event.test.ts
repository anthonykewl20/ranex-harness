import { describe, expect, test } from "bun:test"
import { Event } from "@ranex/schema/event"
import { ManagedOutput } from "@ranex/schema/managed-output"
import { ProjectedEvent } from "@ranex/core/projected-event"

const durable = (data: Record<string, unknown>) => ({
  id: Event.ID.create(),
  type: "session.next.tool.success",
  durable: { aggregateID: "ses_projection", seq: 1, version: 1 },
  data,
})

describe("ProjectedEvent", () => {
  test("bounds text on Unicode code point boundaries and preserves a durable payload reference", () => {
    const result = ProjectedEvent.project(durable({ text: "😀".repeat(5_000) }))
    const text = (result.event.data as { text: string }).text
    expect(result.event.truncated).toBe(true)
    expect(result.event.payloadID).toBe(result.event.id)
    expect(text).toContain("😀")
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(ProjectedEvent.MAX_FIELD_BYTES)
  })

  test("projects oversized records, content arrays, and prompt files deterministically", () => {
    const event = durable({
      structured: { value: "x".repeat(ProjectedEvent.MAX_FIELD_BYTES) },
      content: [{ type: "text", text: "x".repeat(ProjectedEvent.MAX_FIELD_BYTES) }],
      files: [{ uri: `data:text/plain,${"x".repeat(ProjectedEvent.MAX_FIELD_BYTES)}` }],
    })
    const first = ProjectedEvent.project(event).event
    const second = ProjectedEvent.project(event).event
    expect(first).toEqual(second)
    expect(first.data).toMatchObject({
      structured: {},
      content: [{ type: "text", text: expect.stringContaining("omitted") }],
      files: [{ type: "text", text: expect.stringContaining("omitted") }],
    })
  })

  test("uses the total fallback and never attaches payload identifiers to live fragments", () => {
    const result = ProjectedEvent.project({
      id: Event.ID.create(),
      type: "text.delta",
      data: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`value${index}`, "x".repeat(8_000)])),
    })
    expect(result.event.truncated).toBe(true)
    expect(result.event.payloadID).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(result.event), "utf8")).toBeLessThanOrEqual(ProjectedEvent.MAX_EVENT_BYTES)
  })

  test("keeps an event at the total byte boundary and falls back one byte beyond it", () => {
    const event = { id: Event.ID.create(), type: "test.boundary", data: { a: "x".repeat(8_192), b: "x".repeat(8_192), c: "x".repeat(8_192), d: "" } }
    const size = Buffer.byteLength(JSON.stringify({ ...event, truncated: false }), "utf8")
    const atLimit = { ...event, data: { ...event.data, d: "x".repeat(ProjectedEvent.MAX_EVENT_BYTES - size) } }
    expect(Buffer.byteLength(JSON.stringify({ ...atLimit, truncated: false }), "utf8")).toBe(ProjectedEvent.MAX_EVENT_BYTES)
    expect(ProjectedEvent.project(atLimit).event.truncated).toBe(false)
    expect(ProjectedEvent.project({ ...atLimit, data: { ...atLimit.data, d: atLimit.data.d + "x" } }).event).toMatchObject({
      data: {},
      truncated: true,
    })
  })

  test("moves opaque managed references into the envelope and omits paths", () => {
    const outputID = ManagedOutput.ID.make("out_projection")
    const result = ProjectedEvent.project(durable({ outputPaths: ["/private/output"], outputRefs: [outputID] }))
    expect(result.event).toMatchObject({ outputRefs: [outputID], truncated: true, payloadID: result.event.id })
    expect(result.event.data).not.toHaveProperty("outputPaths")
    expect(result.event.data).not.toHaveProperty("outputRefs")
  })

  test("caps opaque output references", () => {
    const refs = Array.from({ length: 129 }, () => ManagedOutput.ID.create())
    const result = ProjectedEvent.project(durable({ outputRefs: refs }))
    expect(result.event).toMatchObject({ truncated: true, outputRefs: refs.slice(0, 128) })
    expect(Buffer.byteLength(JSON.stringify(result.event), "utf8")).toBeLessThanOrEqual(ProjectedEvent.MAX_EVENT_BYTES)
  })

  test("marks projection defects", () => {
    const data: { cyclic?: unknown } = {}
    data.cyclic = data
    expect(ProjectedEvent.project({ id: Event.ID.create(), type: "test.cyclic", data })).toMatchObject({
      event: { data: {}, truncated: true },
      failed: true,
      errorName: "TypeError",
    })
  })
})
