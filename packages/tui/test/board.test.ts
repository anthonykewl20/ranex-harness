import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import Board, { ROUTE } from "../src/feature-plugins/board"
import { createBuiltinPlugins } from "../src/feature-plugins/builtins"

const ROOT = path.join(import.meta.dir, "..")

/** Enough of the plugin API to observe what the board registers. */
function stub() {
  const routes: { name: string }[] = []
  const commands: { name: string; slashName?: string }[] = []
  return {
    calls: { routes, commands },
    api: {
      route: {
        register(list: { name: string }[]) {
          routes.push(...list)
          return () => {}
        },
        navigate() {},
        current: { type: "home" },
      },
      keymap: {
        registerLayer(layer: { commands?: { name: string; slashName?: string }[] }) {
          commands.push(...(layer.commands ?? []))
          return () => {}
        },
      },
      ui: { dialog: { clear() {} } },
      theme: { current: {} },
    },
  }
}

describe("the board plugin", () => {
  test("registers its route and a way to reach it", async () => {
    const { api, calls } = stub()
    await Board.tui(api as never, undefined, {} as never)

    expect(calls.routes.map((route) => route.name)).toEqual([ROUTE])
    // Reachable by name, not only by keybinding: crush has an open issue about
    // terminal shortcuts colliding with app shortcuts, so a command that only
    // exists as a chord is a command some operators cannot press.
    expect(calls.commands.map((command) => command.slashName)).toContain("board")
  })

  test("is registered as a builtin", () => {
    const ids = createBuiltinPlugins({ experimentalEventSystem: false }).map((plugin) => plugin.id)
    expect(ids).toContain("ranex-board")
  })
})

describe("ADR-018: the board is additive", () => {
  // The whole two-way door argument rests on this. packages/tui sits about 163
  // insertions from the opencode fork base; if the board edits the session route
  // or the app shell, every future upstream merge pays for it and deleting the
  // board no longer returns the harness to stock.
  test("it does not reach into the session route or the app shell", () => {
    // Imports only. Prose may name these files — the comments in the board do —
    // and a raw substring check would fail on its own documentation.
    const imports = readFileSync(path.join(ROOT, "src/feature-plugins/board/index.tsx"), "utf8")
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"))
      .join("\n")

    for (const forbidden of ["routes/session", "../../app", "context/route"]) {
      expect(imports).not.toContain(forbidden)
    }
  })

  test("the app shell knows nothing about the board", () => {
    // It is reached as a plugin route, so no Route variant and no Match arm was
    // added. If this ever fails, the door stopped being two-way.
    for (const file of ["src/app.tsx", "src/context/route.tsx"]) {
      expect(readFileSync(path.join(ROOT, file), "utf8")).not.toContain("ranex.board")
    }
  })
})
