export * as ServerAuth from "./auth"

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
}

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        return Config.of(
          yield* EffectConfig.all({
            password: EffectConfig.string("RANEX_SERVER_PASSWORD").pipe(EffectConfig.option),
            username: EffectConfig.string("RANEX_SERVER_USERNAME").pipe(EffectConfig.withDefault("ranex")),
          }),
        )
      }),
    )
  }
}

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
  const password = credentials?.password ?? process.env.RANEX_SERVER_PASSWORD
  if (!password) return undefined

  return `Basic ${Buffer.from(`${credentials?.username ?? process.env.RANEX_SERVER_USERNAME ?? "ranex"}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}

// Stateless URL auth tickets: base64url(scope + ":" + expiryUnixSeconds) + "." +
// base64url(hmacSha256(ticketSecret, payloadSegment)). The MAC covers the exact
// payload segment text, so verification never re-encodes attacker input.
export const TICKET_TTL_SECONDS = 600

// "url-auth" tickets are accepted only on the endpoints that need URL
// credentials because the channel cannot carry an Authorization header
// (SSE event stream, PTY WebSocket connect, web UI navigation). "api" tickets
// are accepted on the query channel anywhere and exist only as an explicit
// opt-in at mint time.
export type TicketScope = "url-auth" | "api"

function ticketScope(value: string): TicketScope | undefined {
  return value === "url-auth" || value === "api" ? value : undefined
}

// The MAC key is an independent process-local random secret, never the Basic
// password: a password-keyed MAC would turn every leaked ticket into an
// offline password-guessing verifier. Tickets are therefore ephemeral
// per-process credentials — a restart invalidates every outstanding ticket,
// which is fine: URL clients (SSE reconnects, browser navigation) re-mint
// with Basic credentials.
let ticketSecret: Buffer | undefined

function currentTicketSecret() {
  if (ticketSecret === undefined) ticketSecret = randomBytes(32)
  return ticketSecret
}

// Test seam: rotating the secret simulates a process restart, proving old
// tickets died with the process that minted them. Production never calls it.
export function resetTicketSecret() {
  ticketSecret = undefined
}

export function mintTicket(nowSeconds?: number, scope?: TicketScope): { ticket: string; expiresAt: string }
// Legacy shape (pre secret-keying): the first argument was the Basic
// password. Accepted so existing call sites keep compiling; ignored — the
// MAC key is the process-local ticket secret, never the password.
export function mintTicket(
  legacyPassword?: string,
  nowSeconds?: number,
  scope?: TicketScope,
): { ticket: string; expiresAt: string }
export function mintTicket(
  first?: number | string,
  second?: number | TicketScope,
  third?: TicketScope,
): { ticket: string; expiresAt: string } {
  const legacy = typeof first === "string"
  const nowSeconds = ((legacy ? second : first) as number | undefined) ?? Math.floor(Date.now() / 1000)
  const scope = ((legacy ? third : second) as TicketScope | undefined) ?? "url-auth"
  const expiry = nowSeconds + TICKET_TTL_SECONDS
  const payload = Buffer.from(`${scope}:${expiry}`).toString("base64url")
  const mac = createHmac("sha256", currentTicketSecret()).update(payload).digest("base64url")
  return { ticket: `${payload}.${mac}`, expiresAt: new Date(expiry * 1000).toISOString() }
}

// Returns the verified scope, or undefined when the ticket is forged,
// malformed, or expired. A ticket presented outside its scope is the
// middleware's decision, not the verifier's.
export function verifyTicket(
  ticket: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): TicketScope | undefined {
  const separator = ticket.indexOf(".")
  if (separator === -1 || ticket.indexOf(".", separator + 1) !== -1) return undefined
  const payload = ticket.slice(0, separator)
  const mac = Buffer.from(ticket.slice(separator + 1), "base64url")
  const expected = createHmac("sha256", currentTicketSecret()).update(payload).digest()
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return undefined
  const scopeExpiry = Buffer.from(payload, "base64url").toString("utf8")
  const scopeSeparator = scopeExpiry.indexOf(":")
  if (scopeSeparator === -1) return undefined
  const scope = ticketScope(scopeExpiry.slice(0, scopeSeparator))
  if (scope === undefined) return undefined
  const expiry = scopeExpiry.slice(scopeSeparator + 1)
  return /^\d+$/.test(expiry) && Number(expiry) > nowSeconds ? scope : undefined
}

// An "api" ticket satisfies any endpoint; a "url-auth" ticket only endpoints
// inside the URL-auth scope.
export function ticketScopeAllows(verified: TicketScope | undefined, required: TicketScope) {
  return verified === "api" || verified === required
}

// Per-client tracking of failed authentication. Process-global on purpose:
// every middleware instance in the process shares one budget per client.
const AUTH_FAILURE_LIMIT = 5
const AUTH_FAILURE_WINDOW_MS = 15 * 60_000
const AUTH_LOCKOUT_CAP_MS = 24 * 60 * 60_000
const AUTH_FAILURE_CAPACITY = 10_000

type AuthFailureEntry = {
  failures: number[]
  lockouts: number
  lockedUntil: number
}

const authFailures = new Map<string, AuthFailureEntry>()

// Failure budgets are keyed per listener realm + client, so independent
// listeners in one process (different ServerAuth configs) never pollute each
// other's lockout state. The realm is a digest of the configured credentials:
// same account → shared budget, different accounts → separate budgets.
export function authRealm(config: Info) {
  return createHash("sha256")
    .update(`${config.username}:${Option.isSome(config.password) ? config.password.value : ""}`)
    .digest("hex")
    .slice(0, 16)
}

// In-process web-handler conversions carry no remote address; those fall back
// to a digest of the Authorization header so credential-less probes share one bucket.
export function authFailureKey(request: HttpServerRequest.HttpServerRequest, realm: string) {
  const remote = request.remoteAddress
  if (remote && Option.isSome(remote)) return `${realm}:${remote.value}`
  return `${realm}:${createHash("sha256").update(request.headers.authorization ?? "").digest("hex").slice(0, 16)}`
}

function freshFailures(failures: number[], now: number) {
  return failures.filter((time) => now - time < AUTH_FAILURE_WINDOW_MS)
}

// Exponential escalation: the lockout after N consecutive lockouts lasts the
// base window doubled N times, capped at 24 hours. A successful
// authentication outside an active lockout clears the whole entry, resetting
// the escalation; during a lockout, valid credentials are served but the
// lockout stands (the middleware owns that decision — see authRateLimitStatus).
function startLockout(entry: AuthFailureEntry, now: number) {
  if (entry.lockedUntil > now || entry.failures.length < AUTH_FAILURE_LIMIT) return
  entry.lockedUntil = now + Math.min(AUTH_FAILURE_WINDOW_MS * 2 ** entry.lockouts, AUTH_LOCKOUT_CAP_MS)
  entry.lockouts += 1
}

export function authRateLimited(key: string, now = Date.now()) {
  const entry = authFailures.get(key)
  if (!entry) return { blocked: false, retryAfterSeconds: 0 }
  entry.failures = freshFailures(entry.failures, now)
  startLockout(entry, now)
  if (entry.lockedUntil <= now) return { blocked: false, retryAfterSeconds: 0 }
  return {
    blocked: true,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)),
  }
}

export function recordAuthFailure(key: string, now = Date.now()) {
  let entry = authFailures.get(key)
  if (!entry) {
    entry = { failures: [], lockouts: 0, lockedUntil: 0 }
    authFailures.set(key, entry)
  }
  entry.failures = freshFailures(entry.failures, now)
  entry.failures.push(now)
  // Failures during an active lockout do not extend it: blocked requests are
  // rejected before failure recording, so the escalation itself is the deterrent.
  startLockout(entry, now)
  while (authFailures.size > AUTH_FAILURE_CAPACITY) {
    const oldest = authFailures.keys().next().value
    if (oldest === undefined) break
    authFailures.delete(oldest)
  }
}

export function clearAuthFailures(key: string) {
  authFailures.delete(key)
}

// Test seam: failed-auth tracking is process-global mutable state.
export function resetAuthFailures() {
  authFailures.clear()
}

// Rate limiting is best-effort hardening: an internal error must never wedge auth.
export function safely<T>(thunk: () => T): T | undefined {
  try {
    return thunk()
  } catch {
    return undefined
  }
}

// The status peek is split from the response so middleware can evaluate
// credentials first: valid credentials are served even during an active
// lockout, invalid ones collect the 429 — brute-force throttling stays, a
// legitimate client behind a shared NAT address is not locked out.
export function authRateLimitStatus(request: HttpServerRequest.HttpServerRequest, realm: string) {
  return safely(() => authRateLimited(authFailureKey(request, realm))) ?? { blocked: false, retryAfterSeconds: 0 }
}

export function rateLimitResponse(limit: { blocked: boolean; retryAfterSeconds: number }) {
  if (!limit.blocked) return undefined
  // ±20% jitter on the advertised Retry-After only: the lockout state itself
  // stays exact, so the response never promises a different rule than the one
  // enforced, and jitter cannot leak sub-second precision.
  const retryAfterSeconds = Math.max(1, Math.round(limit.retryAfterSeconds * (0.8 + Math.random() * 0.4)))
  return HttpServerResponse.jsonUnsafe(
    { error: "Too many failed authentication attempts" },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
  )
}
