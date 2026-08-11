import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { BOARD_ACTIONS } from "../src/feature-plugins/board/actions"
import { OwnerView, operatorWording } from "../src/feature-plugins/board/owner-view"
import type { BoardData } from "../src/feature-plugins/board/pane"
import { createTuiPluginApi } from "./fixture/tui-plugin"

const ROOT = path.join(import.meta.dir, "..")
const OWNER_SOURCE = readFileSync(path.join(ROOT, "src/feature-plugins/board/owner-view.tsx"), "utf8")
const SHELL_SOURCE = readFileSync(path.join(ROOT, "src/feature-plugins/board/index.tsx"), "utf8")

async function capture(data: BoardData) {
  const app = await testRender(() => OwnerView({ api: createTuiPluginApi(), data }), { width: 100, height: 20 })
  try {
    await app.renderOnce()
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

describe("the board owner view", () => {
  test("uses the board data union rather than a second owner data path", async () => {
    expect(OWNER_SOURCE).toMatch(/import type \{ BoardData \} from "\.\/pane"/)
    expect(OWNER_SOURCE).toContain('props.data.state === "unread"')
    expect(OWNER_SOURCE).not.toMatch(/from ["'].+owner-data/)
    expect(SHELL_SOURCE).toContain("<OwnerView api={props.api} data={data()} />")
    expect(SHELL_SOURCE).toContain("pane.render({ api: props.api, data: data() })")

    expect(await capture({ state: "unread", why: "the return channel does not exist" })).toContain(
      "the return channel does not exist",
    )
    expect(await capture({ state: "read", record: { verdict: "FAIL", subject_digest: "sha256:owner" } })).toContain(
      "sha256:owner",
    )
  })

  test("has a reachable view command that is not a board action", () => {
    expect(SHELL_SOURCE).toContain('name: "board.view.owner"')
    expect(SHELL_SOURCE).toMatch(/key:\s*"o",\s*cmd:\s*"board\.view\.owner"/)
    expect(BOARD_ACTIONS.map((action) => action.id)).not.toContain("view.owner")
  })

  test("renders unread honestly and read records as unchanged operator wording", async () => {
    const unread = await capture({ state: "unread", why: "no kernel return channel" })
    expect(unread).toContain("There is nothing to decide yet")
    expect(unread).toContain("no kernel return channel")
    expect(unread).toContain("ranex gate evaluate")

    const read = await capture({ state: "read", record: { verdict: "FAIL", subject_digest: "sha256:abc123" } })
    expect(read).toContain("verdict FAIL")
    expect(read).toContain("subject sha256:abc123")
    expect(read).toContain("Operator wording is shown unchanged")
  })

  test("preserves distinct operator causes instead of translating them", () => {
    expect(operatorWording("absent")).toBe("absent")
    expect(operatorWording("refused")).toBe("refused")
    expect(operatorWording("absent")).not.toBe(operatorWording("refused"))
    expect(OWNER_SOURCE).not.toMatch(/\.replace\(|\.toLowerCase\(|\.toUpperCase\(/)
  })

  test("holds no dispatch, export, approval, merge, or journal authority", () => {
    expect(OWNER_SOURCE).not.toMatch(/dispatchAction|performExport|journal|approve|merge/i)
  })
})
