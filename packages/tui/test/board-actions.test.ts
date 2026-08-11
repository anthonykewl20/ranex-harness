import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  BOARD_ACTIONS,
  NO_CHANNEL_REASON,
  actionById,
  boardActionState,
  dispatchAction,
  resolveAction,
  type BoardActionState,
} from "../src/feature-plugins/board/actions"

const ROOT = path.join(import.meta.dir, "..")
const ACTIONS_SOURCE = readFileSync(path.join(ROOT, "src/feature-plugins/board/actions.ts"), "utf8")
const VIEW_SOURCE = readFileSync(path.join(ROOT, "src/feature-plugins/board/actions-view.tsx"), "utf8")
const SHELL_SOURCE = readFileSync(path.join(ROOT, "src/feature-plugins/board/index.tsx"), "utf8")

const STATES: readonly BoardActionState[] = ["no-subject", "subject-read"]

/**
 * Source with comments removed.
 *
 * These assertions are about code, and the comments here discuss the very words
 * being forbidden — they explain why nothing ranks and why the upstream keymap
 * is left alone. Matching raw text failed a file for documenting its own rule,
 * which is the wrong-accusation defect this repository has fixed before.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

describe("the action table", () => {
  test("every action has a unique id and a unique key", () => {
    const ids = BOARD_ACTIONS.map((action) => action.id)
    const keys = BOARD_ACTIONS.map((action) => action.key)
    expect(ids).toEqual([...new Set(ids)])
    expect(keys).toEqual([...new Set(keys)])
  })

  test("no action key collides with the board's exit", () => {
    // `escape` and `q` leave the board. A verb bound to either would make the
    // exit ambiguous, which is how the route became a trap the first time.
    for (const action of BOARD_ACTIONS) {
      expect(["q", "escape"]).not.toContain(action.key)
    }
  })

  test("resolveAction is total over every action in every state", () => {
    // The point of the table. An action added without a rule fails here rather
    // than falling through to whatever branch happened to be last — the defect
    // found in a mature policy engine, where one closed set was handled three
    // different ways by four switches in a single file.
    for (const action of BOARD_ACTIONS) {
      for (const state of STATES) {
        const outcome = resolveAction(action, state)
        expect(["refused", "undeliverable", "unchanged", "done"]).toContain(outcome.kind)
      }
    }
  })

  test("neither the table nor its renderer has a default arm", () => {
    expect(codeOnly(ACTIONS_SOURCE)).not.toMatch(/\bdefault\s*:/)
    expect(codeOnly(VIEW_SOURCE)).not.toMatch(/\bdefault\s*:/)
  })

  test("nothing ranks, sorts or scores an action", () => {
    for (const source of [ACTIONS_SOURCE, VIEW_SOURCE]) {
      expect(codeOnly(source)).not.toMatch(/\b(?:severity|priority|rank|score)\b/i)
      expect(codeOnly(source)).not.toMatch(/\b(?:sort|toSorted)\s*\(/)
    }
  })
})

describe("legality", () => {
  test("with no subject read, every action is refused with a reason", () => {
    for (const action of BOARD_ACTIONS) {
      const outcome = resolveAction(action, "no-subject")
      expect(outcome.kind).toBe("refused")
      // Refused is not enough. A refusal that does not say why is a key that
      // does nothing, wearing a label.
      expect(outcome.kind === "refused" && outcome.reason.length).toBeGreaterThan(0)
      expect(outcome.kind === "refused" && outcome.reason).toContain(action.id)
    }
  })

  test("boardActionState derives from whether a verdict was read, and nothing else", () => {
    expect(boardActionState(false)).toBe("no-subject")
    expect(boardActionState(true)).toBe("subject-read")
  })
})

describe("the kernel decides, not the board", () => {
  test("every kernel request is undeliverable while no channel exists", () => {
    for (const action of BOARD_ACTIONS.filter((candidate) => candidate.effect === "kernel-request")) {
      const outcome = resolveAction(action, "subject-read")
      expect(outcome.kind).toBe("undeliverable")
      expect(outcome.kind === "undeliverable" && outcome.reason).toBe(NO_CHANNEL_REASON)
    }
  })

  test("approve never reports success from the board", () => {
    // The board holds no key and performs no merge. If approve can ever render
    // as done without the kernel answering, the screen is claiming a verdict
    // the kernel never issued — which is the one thing this project exists to
    // make impossible.
    for (const state of STATES) {
      const outcome = resolveAction(actionById("approve"), state)
      expect(outcome.kind).not.toBe("done")
    }
  })

  test("pressing approve twice yields the same outcome and accumulates no state", () => {
    const first = dispatchAction("approve", "subject-read", false)
    const second = dispatchAction("approve", "subject-read", false)
    expect(second).toEqual(first)
  })

  test("no code path in the board approves, merges, or writes a journal entry", () => {
    for (const source of [ACTIONS_SOURCE, VIEW_SOURCE, SHELL_SOURCE]) {
      expect(codeOnly(source)).not.toMatch(/\bjournal\.(?:append|write)\b/)
      expect(source).not.toMatch(/\b(?:performMerge|doMerge|mergeInto|writeVerdict|signVerdict)\b/)
    }
  })
})

describe("dispatch", () => {
  test("an open dialog swallows the key, and says so rather than dropping it", () => {
    const outcome = dispatchAction("rerun", "subject-read", true)
    expect(outcome.kind).toBe("unchanged")
    expect(outcome.kind === "unchanged" && outcome.detail).toContain("dialog")
  })

  test("the dialog guard applies to every action, including refused ones", () => {
    for (const action of BOARD_ACTIONS) {
      // Even an action that would be refused must not reach the board while a
      // modal is up: the modal owns the keyboard, and a refusal message
      // appearing behind it is the board acting on a press it never received.
      expect(dispatchAction(action.id, "no-subject", true).kind).toBe("unchanged")
    }
  })

  test("a local action completes here and says nothing was judged", () => {
    const outcome = dispatchAction("open-diff", "subject-read", false)
    expect(outcome.kind).toBe("done")
    expect(outcome.kind === "done" && outcome.detail).toContain("nothing was judged")
  })
})

describe("keymap as data", () => {
  test("the shell generates its commands and bindings from the table", () => {
    // Two lists is how a footer starts lying about what a key does. The shell
    // must map over BOARD_ACTIONS rather than repeat it.
    expect(SHELL_SOURCE).toContain("BOARD_ACTIONS.map")
    for (const action of BOARD_ACTIONS) {
      expect(SHELL_SOURCE).not.toContain(`"board.${action.id}"`)
    }
  })

  test("the board registers through the keymap API rather than reaching past it", () => {
    // ADR-018: divergence confined to files upstream does not own. keymap.tsx
    // and which-key.tsx are opencode's, at 7 and 1 insertions from the fork
    // base. Consuming `useBindings` is using that API and is correct; reaching
    // into the overlay that renders it would be rewriting upstream's job.
    //
    // This asserts the shape. Whether those two files actually moved is a
    // question about git, not about this source, and is checked at review with
    // `git diff --shortstat <fork-base> -- <path>` — a test cannot see it.
    expect(SHELL_SOURCE).toContain("useBindings")
    for (const source of [ACTIONS_SOURCE, VIEW_SOURCE, SHELL_SOURCE]) {
      expect(codeOnly(source)).not.toContain("which-key")
      expect(codeOnly(source)).not.toContain("command-palette")
    }
  })
})
