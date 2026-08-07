import { appendFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import type { Plugin } from "@ranex/plugin"

const message = "chore(ranex): bridge run"

export const RanexBridgePlugin: Plugin = async (input) => {
  let emitted = false

  return {
    event: async ({ event }) => {
      if (emitted || event.type !== "session.status" || event.properties.status?.type !== "idle") return
      const emit = process.env.RANEX_EMIT
      const taskID = process.env.RANEX_TASK_ID
      if (!emit || !taskID) return
      const worktree = path.resolve(input.directory)
      try {
        if (
          execFileSync("git", ["-C", worktree, "rev-parse", "--is-inside-work-tree"], {
            encoding: "utf8",
            stdio: "pipe",
          }).trim() !== "true"
        )
          return
        if (execFileSync("git", ["-C", worktree, "status", "--porcelain"], { encoding: "utf8" }).trim()) {
          execFileSync("git", ["-C", worktree, "add", "-A"])
          execFileSync("git", ["-C", worktree, "commit", "-m", message])
        }
        const commit = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
        appendFileSync(emit, JSON.stringify({ task_id: taskID, worktree, commit }) + "\n")
        emitted = true
      } catch (error) {
        console.error(`ranex bridge: failed to emit for task ${taskID} in ${worktree}:`, error)
      }
    },
  }
}
