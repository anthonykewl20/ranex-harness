import type { BoardPane } from "../pane"
import { GatesPane } from "./gates"
import { JournalPane } from "./journal"
import { RunPane } from "./run"
import { SpecificationPane } from "./specification"

/**
 * The board's panes, in one list.
 *
 * **Adding a pane is two edits and no more:** one module in this directory, and
 * one entry below. Nothing else in the board is touched — not the shell, not
 * another pane, and nothing upstream owns. That is what lets BOARD-05..BOARD-14
 * be built concurrently in separate worktrees without colliding.
 *
 * Order comes from each pane's `order` field, not from this array, so two panes
 * added at the same time cannot silently reorder one another. The reserved
 * spacing, so concurrent work does not collide on a number either:
 *
 *   100  BOARD-05  gates and causes
 *   200  BOARD-06  evidence and admission
 *   300  BOARD-07  specification — packet A, manifest B, envelope C
 *   400  BOARD-08  run — bound command, confinement, worktree
 *   500  BOARD-09  diff, bound to the subject digest
 *   600  BOARD-12  journal and chain verification
 *   700  BOARD-13  escalation
 *
 * A pane must render something honest for `data.state === "unread"`. That is not
 * a convention: `BoardData` is a union, so the compiler will not let a pane
 * reach a record that was never read.
 */
export const PANES: readonly BoardPane[] = [GatesPane, SpecificationPane, RunPane, JournalPane]
