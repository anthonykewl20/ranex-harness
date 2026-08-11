import { assertEntries, type AnyTranscriptEntry } from "../entry"
import { AssistantEntry } from "./assistant"
import { ReasoningEntry } from "./reasoning"
import { ToolEntry } from "./tool"
import { UserEntry } from "./user"

/**
 * The transcript's entries, in one list.
 *
 * **Adding an entry is two edits and no more:** one module in this directory,
 * and one entry below. Nothing else in the transcript is touched — not the
 * chrome, not another entry, and nothing upstream owns. That is what lets
 * CHAT-03..CHAT-09 be built concurrently in separate worktrees without
 * colliding.
 *
 * Order comes from each entry's own `order` field, not from this array, and
 * `assertEntries` throws on a duplicate id, order or kind. Both matter for the
 * same reason: git takes both sides of an array append with no conflict marker,
 * so two entries added concurrently merge clean and then reorder the transcript
 * — or shadow each other — for reasons nobody can see.
 *
 * The reserved spacing, so concurrent work does not collide on a number either:
 *
 *   100  CHAT-03  user
 *   200  CHAT-04  assistant
 *   300  CHAT-05  reasoning
 *   400  CHAT-06  tool
 *   500  CHAT-09  permission
 *   600  CHAT-09  error
 *
 * An entry must render something honest for an item it cannot fully display.
 * There is deliberately no arm for "unknown kind" here: an item no entry claims
 * is the chrome's problem, and it renders the raw payload labelled `unrendered`
 * rather than dropping it.
 */
export const ENTRIES: readonly AnyTranscriptEntry[] = assertEntries([
  UserEntry,
  AssistantEntry,
  ReasoningEntry,
  ToolEntry,
])
