import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionMessage } from "@ranex/core/session/message"
import { SessionRecovery } from "@ranex/core/session/recovery"
import { ModelV2 } from "@ranex/core/model"
import { ProviderV2 } from "@ranex/core/provider"

const assistantID = SessionMessage.ID.make("msg_recovery")

function assistant(content: SessionMessage.Assistant["content"], completed = false) {
  return SessionMessage.Assistant.make({
    id: assistantID,
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content,
    time: completed ? { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) } : { created: DateTime.makeUnsafe(0) },
  })
}

describe("SessionRecovery.classify", () => {
  test("active blockers dominate every other durable signal", () => {
    expect(SessionRecovery.classify({
      messages: [assistant([])],
      latestSeq: 4,
      retry: { attempt: 1, nextAttemptAt: 10 },
      blockers: [{ kind: "provider_in_flight" }],
    })).toEqual({ _tag: "Idle" })
  })

  test("an unsettled called tool is interrupted before provider ambiguity", () => {
    expect(SessionRecovery.classify({
      messages: [assistant([SessionMessage.AssistantTool.make({
        type: "tool",
        id: "call_recovery",
        name: "write",
        time: { created: DateTime.makeUnsafe(0) },
        state: SessionMessage.ToolStateRunning.make({ status: "running", input: {}, structured: {}, content: [] }),
      })])],
      latestSeq: 9,
      blockers: [],
    })).toEqual({ _tag: "InterruptAmbiguousTool", assistantMessageID: assistantID, callID: "call_recovery" })
  })

  test("a settled tool continuation is safe while a bare provider turn is blocked", () => {
    expect(SessionRecovery.classify({
      messages: [assistant([SessionMessage.AssistantTool.make({
        type: "tool",
        id: "call_settled",
        name: "read",
        time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
        state: SessionMessage.ToolStateCompleted.make({
          status: "completed", input: {}, structured: {}, content: [], outputPaths: [], outputRefs: [], result: "ok",
        }),
      })])],
      latestSeq: 12,
      blockers: [],
    })).toEqual({ _tag: "ContinueCommitted", after: 12 })
    expect(SessionRecovery.classify({ messages: [assistant([])], latestSeq: 13, blockers: [] })).toEqual({
      _tag: "BlockAmbiguousProvider",
      assistantMessageID: assistantID,
    })
  })

  test("a persisted retry waits only when no active provider turn remains", () => {
    expect(SessionRecovery.classify({
      messages: [assistant([], true)],
      latestSeq: 1,
      retry: { attempt: 2, nextAttemptAt: 100 },
      blockers: [],
    })).toEqual({ _tag: "WaitForRetry", retry: { attempt: 2, nextAttemptAt: 100 } })
  })
})
