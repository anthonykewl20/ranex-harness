import { ServerAuth } from "../auth"
import { CorsConfig, isAllowedHost, isAllowedRequestOrigin, type CorsOptions } from "../cors"
import { UnauthorizedError } from "@ranex/protocol/errors"
import { Authorization } from "@ranex/protocol/middleware/authorization"
export { Authorization } from "@ranex/protocol/middleware/authorization"
import { hasPtyConnectTicketURL } from "@ranex/protocol/groups/pty"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const AUTH_TOKEN_QUERY = "auth_token"
const FORBIDDEN = 403
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'
// Raw Basic credentials in the URL leak into logs and history; the query
// channel accepts short-lived tickets only.
const TICKET_HINT =
  "auth_token query parameter accepts short-lived tickets only; send Basic credentials in the Authorization header"
const WWW_AUTHENTICATE_TICKET = `Basic realm="Secure Area", error="invalid_request", error_description="${TICKET_HINT}"`

// DNS-rebinding defense: reject requests whose Host is a non-allowlisted domain name
// (rebound pages keep the attacker domain in Host) and, when a browser supplies Origin,
// origins that are not allowed for this host. Runs before any credential evaluation.
// Requests without a Host header are in-process web-handler conversions, not network
// traffic, so there is no host to validate.
function isDisallowedClient(request: HttpServerRequest.HttpServerRequest, cors?: CorsOptions) {
  const { origin, host } = request.headers
  if (!host) return false
  if (origin && !isAllowedRequestOrigin(origin, host, cors)) return true
  return !isAllowedHost(host, cors)
}

function guardClientOrigin<A, E, R>(effect: Effect.Effect<A, E, R>, cors?: CorsOptions) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (isDisallowedClient(request, cors)) return HttpServerResponse.empty({ status: FORBIDDEN })
    return yield* effect
  })
}

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromHeader(request: HttpServerRequest.HttpServerRequest) {
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

// The query ticket channel exists for endpoints whose client cannot carry an
// Authorization header: the SSE event stream (/api/event) and the PTY
// WebSocket connect (/api/pty/:id/connect, mirroring the protocol group's
// path shape). A query ticket anywhere else must be an explicit "api" ticket.
const URL_AUTH_EVENT_PATH = "/api/event"
const URL_AUTH_PTY_CONNECT_PATH = /^\/api\/pty\/[^/]+\/connect$/
const TICKET_MINT_PATH = "/api/ticket"

function requiredTicketScope(pathname: string): ServerAuth.TicketScope {
  return pathname === URL_AUTH_EVENT_PATH || URL_AUTH_PTY_CONNECT_PATH.test(pathname) ? "url-auth" : "api"
}

function ticketAuthorized(token: string, scope: ServerAuth.TicketScope) {
  return ServerAuth.ticketScopeAllows(ServerAuth.verifyTicket(token), scope)
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const cors = yield* CorsConfig
    if (!ServerAuth.required(config)) return Authorization.of((effect) => guardClientOrigin(effect, cors))
    return Authorization.of((effect) =>
      guardClientOrigin(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
          // credential checks here; the connect handler consumes and validates the ticket.
          const url = new URL(request.url, "http://localhost")
          if (hasPtyConnectTicketURL(url)) return yield* effect
          // Valid credentials are served even during an active lockout: the
          // lockout throttles brute force, not a legitimate client behind a
          // shared NAT address. Invalid ones collect the 429 below, before
          // any new failure is recorded (the escalation is the deterrent).
          const realm = ServerAuth.authRealm(config)
          const limit = ServerAuth.authRateLimitStatus(request, realm)
          const key = ServerAuth.authFailureKey(request, realm)
          // The Authorization header credential is evaluated first: a client
          // holding valid Basic credentials must never be rejected (or
          // rate-charged) by a garbage query token riding along in the same
          // request. The query ticket is consulted only when the request
          // carries no Basic header credential at all.
          const headerCredential = /^Basic\s+/i.test(request.headers.authorization ?? "")
          const credential = yield* credentialFromHeader(request)
          if (ServerAuth.authorized(credential, config)) {
            // Serving valid credentials during an active lockout does not
            // lift it — the throttle targets the brute-forcer, and a
            // legitimate client behind the same address is served anyway.
            // The budget resets only on success outside a lockout.
            if (!limit.blocked) ServerAuth.safely(() => ServerAuth.clearAuthFailures(key))
            return yield* effect
          }
          if (!headerCredential) {
            const token = url.searchParams.get(AUTH_TOKEN_QUERY)
            if (token) {
              // The mint endpoint takes actual Basic header credentials
              // only: no ticket — whatever its scope — may ever mint its
              // own replacement, so the query-ticket fallback never applies.
              if (url.pathname !== TICKET_MINT_PATH && ticketAuthorized(token, requiredTicketScope(url.pathname))) {
                if (!limit.blocked) ServerAuth.safely(() => ServerAuth.clearAuthFailures(key))
                return yield* effect
              }
              const limited = ServerAuth.rateLimitResponse(limit)
              if (limited) return limited
              ServerAuth.safely(() => ServerAuth.recordAuthFailure(key))
              yield* HttpEffect.appendPreResponseHandler((_request, response) =>
                Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE_TICKET)),
              )
              return yield* new UnauthorizedError({ message: TICKET_HINT })
            }
          }
          const limited = ServerAuth.rateLimitResponse(limit)
          if (limited) return limited
          ServerAuth.safely(() => ServerAuth.recordAuthFailure(key))
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
          )
          return yield* new UnauthorizedError({ message: "Authentication required" })
        }),
        cors,
      ),
    )
  }),
)
