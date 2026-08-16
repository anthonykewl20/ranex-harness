export * as SessionRecovery from "./recovery"

import type { SessionMessage } from "./message"
import type { ProviderMetadata } from "@ranex/llm"

export type Blocker = {
  readonly kind: "provider_in_flight" | "tool_side_effect_ambiguous"
}

export type Resolution = "abandon" | "continue"

export type Decision =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "ContinueCommitted" }
  | {
      readonly _tag: "InterruptAmbiguousTool"
      readonly assistantMessageID: SessionMessage.ID
      readonly callID: string
      readonly provider: { readonly executed: boolean; readonly metadata?: ProviderMetadata }
    }
  | { readonly _tag: "BlockAmbiguousProvider"; readonly assistantMessageID: SessionMessage.ID }
  | { readonly _tag: "WaitForRetry"; readonly retry: { readonly attempt: number; readonly nextAttemptAt: number } }

/**
 * Maps only durable projections to a recovery action. Effects, clock reads, and
 * ownership live in the reconciler so this order stays auditable and testable.
 */
export function classify(input: {
  readonly messages: ReadonlyArray<SessionMessage.Message>
  readonly retry?: { readonly attempt: number; readonly nextAttemptAt: number }
  readonly blockers: ReadonlyArray<Blocker>
}): Decision {
  // Precedence is fail-closed: blocker, invoked tool, provider ambiguity,
  // committed continuation, then persisted retry.
  if (input.blockers.length > 0) return { _tag: "Idle" }
  const assistant = input.messages.findLast(
    (message): message is SessionMessage.Assistant => message.type === "assistant" && !message.time.completed,
  )
  if (assistant) {
    const running = assistant.content.findLast(
      (content): content is SessionMessage.AssistantTool =>
        content.type === "tool" && content.state.status === "running",
    )
    if (running)
      return {
        _tag: "InterruptAmbiguousTool",
        assistantMessageID: assistant.id,
        callID: running.id,
        provider: {
          executed: running.provider?.executed === true,
          ...(running.provider?.metadata === undefined ? {} : { metadata: running.provider.metadata }),
        },
      }
    if (assistant.content.some((content) => content.type === "tool" && content.state.status === "pending"))
      return { _tag: "BlockAmbiguousProvider", assistantMessageID: assistant.id }
    if (assistant.content.some((content) => content.type === "tool"))
      return { _tag: "ContinueCommitted" }
    return { _tag: "BlockAmbiguousProvider", assistantMessageID: assistant.id }
  }
  if (input.retry) return { _tag: "WaitForRetry", retry: input.retry }
  return { _tag: "Idle" }
}
