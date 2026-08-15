export * as ServerAuth from "./auth"

import { createHash, timingSafeEqual } from "node:crypto"
import { ConfigService } from "@/effect/config-service"
import { Flag } from "@ranex/core/flag/flag"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@opencode/ServerAuthConfig", {
  password: EffectConfig.string("RANEX_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("RANEX_SERVER_USERNAME").pipe(EffectConfig.withDefault("ranex")),
}) {}

export type Info = Context.Service.Shape<typeof Config>

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    passwordMatches(Redacted.value(credentials.password), config.password.value) &&
    credentials.username === config.username
  )
}

// Hash both sides before comparing so timingSafeEqual always sees equal-length
// buffers; the digest comparison leaks neither password contents nor length.
function passwordMatches(provided: string, expected: string) {
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest(),
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.RANEX_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.RANEX_SERVER_USERNAME ?? "ranex"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}

// URL auth tickets and failed-auth rate limiting are shared with the v2 server
// package so both stacks verify tickets against the same stateless format and
// one process-wide failure budget per listener realm + client.
export {
  authFailureKey,
  authRateLimited,
  authRateLimitStatus,
  authRealm,
  clearAuthFailures,
  mintTicket,
  rateLimitResponse,
  recordAuthFailure,
  resetAuthFailures,
  resetTicketSecret,
  safely,
  ticketScopeAllows,
  TICKET_TTL_SECONDS,
  verifyTicket,
} from "@ranex/server/auth"

export type { TicketScope } from "@ranex/server/auth"
