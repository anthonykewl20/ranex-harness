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

  return yield* new AuthMissing({
    message:
      "GITHUB_TOKEN is not set. Either set the environment variable, or write your token to ~/.config/opencode/github-token.",
  })
})
