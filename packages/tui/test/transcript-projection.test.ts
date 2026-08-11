import { describe, expect, test } from "bun:test"
import type { TuiPluginApi } from "@ranex/plugin/tui"
import { createProjection } from "../src/feature-plugins/transcript/items"

/**
 * The projection must hand back the SAME object for a row that has not changed.
 *
 * Solid's `For` keys on object identity. Returning freshly-allocated objects
 * every render made it rebuild every row on every streamed delta — the whole
 * transcript repainting per token, which is the flicker the owner reported.
 */
const api = (messages: unknown[], parts: Record<string, unknown[]>) =>
  ({
    state: {
      session: { messages: () => messages, permission: () => [] },
      part: (id: string) => parts[id] ?? [],
    },
  }) as unknown as TuiPluginApi

const assistant = (id: string) => ({ id, role: "assistant", modelID: "m", time: { created: 0 } })
const text = (t: string) => [{ id: "p1", type: "text", text: t }]

describe("CHAT-13: a row that did not change keeps its identity", () => {
  test("an unchanged transcript projects the identical objects twice", () => {
    const project = createProjection()
    const state = api([assistant("m1")], { m1: text("hello") })
    const first = project(state, "s1")
    const second = project(state, "s1")
    expect(first.length).toBe(1)
    expect(second[0]).toBe(first[0])
  })

  test("only the row whose content moved is rebuilt", () => {
    const project = createProjection()
    const parts: Record<string, unknown[]> = { m1: text("first answer"), m2: text("second") }
    const state = api([assistant("m1"), assistant("m2")], parts)
    const before = project(state, "s1")

    // The last message streams another chunk; the first is untouched.
    parts.m2 = text("second answer, now longer")
    const after = project(state, "s1")

    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
  })

  test("a finished turn is rebuilt once, because its footer appears", () => {
    const project = createProjection()
    // The store REPLACES rows rather than mutating them, so completion arrives
    // as a new object. Written as an in-place mutation this passed while the
    // real path would not have — the test would have been lying.
    const messages: unknown[] = [assistant("m1")]
    const state = api(messages, { m1: text("done thinking") })
    const streaming = project(state, "s1")
    messages[0] = { ...assistant("m1"), time: { created: 0, completed: 1200 } }
    expect(project(state, "s1")[0]).not.toBe(streaming[0])
  })

  test("a removed message drops out of the cache rather than accumulating", () => {
    const project = createProjection()
    const messages = [assistant("m1"), assistant("m2")]
    const state = api(messages, { m1: text("a"), m2: text("b") })
    project(state, "s1")
    messages.pop()
    expect(project(state, "s1").length).toBe(1)
  })
})
