import { Effect } from "effect"
import { AuthMissing } from "./error"

export const resolveToken = Effect.fn("GitHub.auth.resolveToken")(function* () {
  const envToken = process.env["GITHUB_TOKEN"]
  if (envToken) return envToken

  const home = process.env["HOME"]
  if (home) {
    const fileToken = yield* Effect.promise(async () => {
      try {
        const file = Bun.file(`${home}/.config/opencode/github-token`)
        if (!(await file.exists())) return null
        return (await file.text()).trim() || null
      } catch {
        return null
      }
    })
    if (fileToken) return fileToken
  }

  const ghToken = yield* Effect.promise(async () => {
    try {
      const proc = Bun.spawn(["gh", "auth", "token"], {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(5_000),
      })
      const exitCode = await proc.exited
      if (exitCode !== 0) return null
      return (await new Response(proc.stdout).text()).trim() || null
    } catch {
      return null
    }
  })
  if (ghToken) return ghToken

  return yield* new AuthMissing({
    message:
      "No GitHub token found. Set GITHUB_TOKEN env var, write to ~/.config/opencode/github-token, or authenticate with `gh auth login`.",
  })
})
