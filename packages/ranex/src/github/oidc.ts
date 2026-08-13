import { getIDToken } from "@actions/core"
import { Effect } from "effect"
import { ApiError } from "./error"

export const getOidcToken = Effect.fn("GitHub.oidc.getOidcToken")(function* (audience: string) {
  return yield* Effect.tryPromise({
    try: () => getIDToken(audience),
    catch: (error) =>
      new ApiError({
        message: `Could not fetch an OIDC token. Make sure to add \`id-token: write\` to your workflow permissions. ${error instanceof Error ? error.message : String(error)}`,
      }),
  })
})

export * as Oidc from "./oidc"
