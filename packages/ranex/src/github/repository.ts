import { Effect } from "effect"
import type { Git } from "@/git"
import { InstanceState } from "@/effect/instance-state"
import { parseGitHubRemoteHosted } from "@/util/repository"
import { resolveHost } from "./auth"
import { RepoNotResolved } from "./error"

export const makeResolveOwnerRepo = (git: Git.Interface) =>
  Effect.fn("GitHub.repository.resolveOwnerRepo")(function* (input: { owner?: string; repo?: string }) {
    if (input.owner && input.repo) return { host: resolveHost(), owner: input.owner, repo: input.repo }
    if (input.owner || input.repo) {
      return yield* new RepoNotResolved({
        message: "Both owner and repo must be specified together; received only one.",
      })
    }
    const ctx = yield* InstanceState.context
    const result = yield* git.run(["remote", "get-url", "origin"], { cwd: ctx.worktree })
    const parsed = parseGitHubRemoteHosted(result.text().trim())
    if (!parsed) {
      return yield* new RepoNotResolved({
        message: `Could not resolve a hosted GitHub remote from "origin" in ${ctx.worktree}.`,
      })
    }
    return parsed
  })
