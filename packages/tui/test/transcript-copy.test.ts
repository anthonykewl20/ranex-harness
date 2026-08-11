import { describe, expect, test } from "bun:test"
import { copyText, lastCopyable } from "../src/feature-plugins/transcript/copy"
import type { TranscriptItem } from "../src/feature-plugins/transcript/entry"

const message = (text: string): TranscriptItem => ({
  kind: "assistant",
  id: "m1",
  message: {} as never,
  parts: [{ type: "text", text }] as never,
})

const runningTool: TranscriptItem = {
  kind: "tool",
  id: "p1",
  message: {} as never,
  part: { tool: "read", state: { status: "running" } } as never,
}

const editTool: TranscriptItem = {
  kind: "tool",
  id: "p2",
  message: {} as never,
  part: { tool: "edit", state: { status: "completed", output: "ok", metadata: { diff: "--- a\n+++ b\n+x" } } } as never,
}

describe("CHAT-15: copy yields content, not chrome", () => {
  test("a message copies its body without the label line", () => {
    // Pasting "ranex  deepseek · zen" into a bug report is noise. The reader
    // wanted the answer.
    expect(copyText(message("the front door is one line"))).toBe("the front door is one line")
  })

  test("a change copies as its diff, which is what a bug report needs", () => {
    expect(copyText(editTool)).toContain("+x")
    expect(copyText(editTool)).not.toBe("ok")
  })

  test("an error copies its cause", () => {
    expect(copyText({ kind: "error", id: "e1", why: "provider aborted" })).toBe("provider aborted")
  })

  test("an approval copies what was being approved", () => {
    expect(copyText({ kind: "permission", id: "r1", request: { id: "r1", title: "edit", body: "packages/**" } })).toBe(
      "edit\npackages/**",
    )
  })
})

describe("CHAT-15: an empty copy is never reported as a success", () => {
  // claude-code #56298 — "Copy message" copying an empty string and saying it
  // worked. The guard is here rather than in the command, so it is testable.
  test("an item with no text yields undefined", () => {
    expect(copyText(runningTool)).toBeUndefined()
    expect(copyText(message("   "))).toBeUndefined()
  })

  test("a bare copy skips past a still-running call to the last real content", () => {
    const items = [message("first"), message("second"), runningTool]
    expect(copyText(lastCopyable(items)!)).toBe("second")
  })

  test("a transcript with nothing copyable yields nothing at all", () => {
    expect(lastCopyable([runningTool])).toBeUndefined()
    expect(lastCopyable([])).toBeUndefined()
  })
})
