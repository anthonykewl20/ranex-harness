/**
 * The board's verbs, declared as data — BOARD-10.
 *
 * Two things this file exists to prevent.
 *
 * **A key that does nothing and says nothing.** Every dispatch returns an
 * outcome, and every outcome is rendered. An action that is illegal here says
 * why; an action that is legal but cannot be delivered says that instead. A
 * silently ignored keypress is indistinguishable from a broken one, and an
 * operator cannot tell which they are looking at.
 *
 * **A second verdict.** The TUI holds no key, writes no journal entry and
 * performs no merge. Approve is a *request*; the kernel alone decides, and it
 * decides by compare-and-swap. So the board keeps no local "approved" state to
 * render optimistically and reconcile later — there is nothing here to
 * reconcile, by construction.
 *
 * Keys are bound as data rather than in a handler, following k9s
 * (`Actions().Bulk`, `AddBindKeysFn`). Scope note: the k9s idea of deriving the
 * help overlay from the same table is deliberately NOT applied to the harness's
 * own keymap layer. `keymap.tsx` and `which-key.tsx` are opencode's files, two
 * lines and seven lines from the fork base, and ADR-018 keeps divergence out of
 * files upstream owns. The board declares its own layer through the plugin API
 * and changes neither.
 */

import { renameSync, rmSync, writeFileSync } from "node:fs"
import type { BoardData } from "./pane"
import { projectBoard } from "./projection"

/** What the board knows about its subject. Nothing else gates an action. */
export type BoardActionState = "no-subject" | "subject-read"

export type BoardActionId = "rerun" | "request-review" | "open-diff" | "export" | "approve"

/**
 * Where an action's effect lives.
 *
 * `local` is the board's own business — navigation or projection, and nothing the kernel would
 * ever need to hear about. `kernel-request` leaves this process, or would if a
 * channel existed. Nothing in between: an action that half-happens locally and
 * half-asks the kernel is the shape that produces an optimistic screen.
 */
export type BoardActionEffect = "local" | "kernel-request"

export type BoardAction = {
  readonly id: BoardActionId
  /** Bound as data; the footer reads the same table, so they cannot disagree. */
  readonly key: string
  readonly title: string
  readonly effect: BoardActionEffect
  /** The states this action is legal in. Membership, never a rank. */
  readonly legalIn: readonly BoardActionState[]
}

export const BOARD_ACTIONS: readonly BoardAction[] = [
  {
    id: "open-diff",
    key: "d",
    title: "Open the diff for this subject",
    effect: "local",
    legalIn: ["subject-read"],
  },
  {
    id: "rerun",
    key: "r",
    title: "Ask the kernel to run the bound command again",
    effect: "kernel-request",
    legalIn: ["subject-read"],
  },
  {
    id: "request-review",
    key: "v",
    title: "Ask for an independent review of this change",
    effect: "kernel-request",
    legalIn: ["subject-read"],
  },
  {
    id: "export",
    key: "x",
    title: "Export this board as evidence",
    effect: "local",
    legalIn: ["subject-read"],
  },
  {
    id: "approve",
    key: "a",
    title: "Ask the kernel to approve this subject",
    effect: "kernel-request",
    legalIn: ["subject-read"],
  },
]

/**
 * Four outcomes, and the three that are not success are not one thing.
 *
 * `refused` — illegal in this state, with the reason.
 * `undeliverable` — legal, but nothing can carry it to the kernel.
 * `unchanged` — legal, already true; a no-op that SUCCEEDS rather than errors.
 * `done` — completed, and completed here.
 */
export type BoardActionOutcome =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "undeliverable"; readonly reason: string }
  | { readonly kind: "unchanged"; readonly detail: string }
  | { readonly kind: "done"; readonly detail: string }

/** Why a kernel request cannot leave the process today. */
export const NO_CHANNEL_REASON = "no channel reaches the kernel; the bridge emits and nothing returns (ADR-019)"

export function actionById(id: BoardActionId): BoardAction {
  const found = BOARD_ACTIONS.find((action) => action.id === id)
  // Not reachable through the registry, which is built from BOARD_ACTIONS. It
  // throws rather than returning a placeholder because a placeholder action
  // would be dispatchable, and a dispatchable action nobody declared is worse
  // than a crash in a terminal.
  if (!found) throw new Error(`no board action with id ${id}`)
  return found
}

/**
 * The whole decision, as one total function over (action, state).
 *
 * Deliberately not a chain of `if`s in the dispatcher. The test asserts this is
 * total over BOARD_ACTIONS × BoardActionState, so an action added without a rule
 * fails a test rather than falling through to whatever the last branch was.
 */
export function resolveAction(action: BoardAction, state: BoardActionState): BoardActionOutcome {
  if (!action.legalIn.includes(state)) {
    return { kind: "refused", reason: refusalReason(action, state) }
  }

  switch (action.effect) {
    case "local":
      return { kind: "done", detail: `${action.id} opened here; nothing was sent and nothing was judged` }
    case "kernel-request":
      return { kind: "undeliverable", reason: NO_CHANNEL_REASON }
  }
}

function refusalReason(action: BoardAction, state: BoardActionState): string {
  switch (state) {
    case "no-subject":
      return `${action.id} needs a subject, and no verdict has been read`
    case "subject-read":
      // Unreachable while every action is legal in "subject-read", and kept
      // because the switch must stay total: adding a state must break here.
      return `${action.id} is not available in this state`
  }
}

/** The board's state, derived from what it was handed and nothing else. */
export function boardActionState(read: boolean): BoardActionState {
  return read ? "subject-read" : "no-subject"
}

/**
 * Dispatch, with the dialog guard.
 *
 * k9s gates on `IsTopDialog()` for the same reason: a modal and the surface
 * behind it must never both act on one press. Returned as an outcome rather
 * than a silent drop, so even a swallowed key is accounted for.
 */
export function dispatchAction(id: BoardActionId, state: BoardActionState, dialogOpen: boolean): BoardActionOutcome {
  const action = actionById(id)
  if (dialogOpen) {
    return { kind: "unchanged", detail: `a dialog is open; ${action.id} was not dispatched` }
  }
  return resolveAction(action, state)
}

/** Export is a local projection after the same legality and dialog guards. */
export function performExport(
  state: BoardActionState,
  data: BoardData,
  destination: string,
  dialogOpen: boolean,
): BoardActionOutcome {
  if (dialogOpen) return { kind: "unchanged", detail: "a dialog is open; export was not dispatched" }
  if (state === "no-subject") return { kind: "refused", reason: refusalReason(actionById("export"), state) }
  if (data.state === "unread") return { kind: "refused", reason: `export refused: ${data.why}` }

  const unavailable = { state: "unavailable" as const, why: "the verdict return channel does not carry this field" }
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`

  try {
    writeFileSync(
      temporary,
      projectBoard({
        subject_digest: data.record.subject_digest,
        gate_id: unavailable,
        catalog_digest: unavailable,
        verdict: data.record.verdict,
        causes: unavailable,
        filters: [],
      }),
      { flag: "wx" },
    )
    renameSync(temporary, destination)
    return { kind: "done", detail: `exported ${destination}; a projection, not a signed record` }
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Cleanup failure must not disguise the refusal that prevented publication.
    }
    return { kind: "refused", reason: `export refused: ${error instanceof Error ? error.message : String(error)}` }
  }
}
