import { Effect } from "effect"
import { AuthMissing } from "./error"

export const resolveToken = Effect.fn("GitHub.auth.resolveToken")(function* () {
  const token = process.env["GITHUB_TOKEN"]
  if (!token) {
    return yield* new AuthMissing({
      message: "GITHUB_TOKEN environment variable is not set. Set it to a GitHub personal access token.",
    })
  }
  return token
})
