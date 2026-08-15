import { ServerAuth } from "@/server/auth"
import { CorsConfig, isAllowedHost, isAllowedRequestOrigin, type CorsOptions } from "@ranex/server/cors"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { hasPtyConnectTicketURL, isPtyConnectPath } from "@/server/shared/pty-ticket"
import { isPublicUIPath } from "@/server/shared/public-ui"
export {
  Authorization as ServerAuthorization,
  authorizationLayer as serverAuthorizationLayer,
} from "@ranex/server/middleware/authorization"

const AUTH_TOKEN_QUERY = "auth_token"
const UNAUTHORIZED = 401
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

// Avoid HttpApiSecurity alternatives here: Effect security middleware wraps the
// full handler, so a downstream failure can make the next auth alternative run
// and remap an authorized NotFound into Unauthorized.
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@opencode/ExperimentalHttpApiAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

export class PtyConnectAuthorization extends HttpApiMiddleware.Service<PtyConnectAuthorization>()(
  "@opencode/ExperimentalHttpApiPtyConnectAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

function emptyCredential() {
  return {
    username: "",
    password: Redacted.make(""),
  }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return {
          username: header.slice(0, separator),
          password: Redacted.make(header.slice(separator + 1)),
        }
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
// Authorization header: the SSE event stream ("/event", the event group's
// EventPaths.event — imported literally because the group mounts this
// middleware) and the PTY WebSocket connect path. A query ticket anywhere else
// must be an explicit "api" ticket.
const TICKET_MINT_PATH = "/api/ticket"

function requiredTicketScope(pathname: string): ServerAuth.TicketScope {
  return pathname === "/event" || isPtyConnectPath(pathname) ? "url-auth" : "api"
}

function hasBasicHeaderCredential(request: HttpServerRequest.HttpServerRequest) {
  return /^Basic\s+/i.test(request.headers.authorization ?? "")
}

function ticketAuthorized(token: string, scope: ServerAuth.TicketScope) {
  return ServerAuth.ticketScopeAllows(ServerAuth.verifyTicket(token), scope)
}

function ticketRejection(request: HttpServerRequest.HttpServerRequest, realm: string) {
  ServerAuth.safely(() => ServerAuth.recordAuthFailure(ServerAuth.authFailureKey(request, realm)))
  return HttpServerResponse.jsonUnsafe(
    { error: TICKET_HINT },
    { status: UNAUTHORIZED, headers: { "www-authenticate": WWW_AUTHENTICATE_TICKET } },
  )
}

function basicRejection(request: HttpServerRequest.HttpServerRequest, realm: string) {
  ServerAuth.safely(() => ServerAuth.recordAuthFailure(ServerAuth.authFailureKey(request, realm)))
  return HttpServerResponse.empty({ status: UNAUTHORIZED, headers: { "www-authenticate": WWW_AUTHENTICATE } })
}

function authorizeCredentials<A, E, R>(effect: Effect.Effect<A, E, R>, config: ServerAuth.Info) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    // Valid credentials are served even during an active lockout: the
    // lockout throttles brute force, not a legitimate client behind a shared
    // NAT address. Invalid ones collect the 429 below, before any new
    // failure is recorded (the escalation is the deterrent).
    const realm = ServerAuth.authRealm(config)
    const limit = ServerAuth.authRateLimitStatus(request, realm)
    const key = ServerAuth.authFailureKey(request, realm)
    const url = new URL(request.url, "http://localhost")
    // The Authorization header credential is evaluated first: a client
    // holding valid Basic credentials must never be rejected (or
    // rate-charged) by a garbage query token riding along in the same
    // request. The query ticket is consulted only when the request
    // carries no Basic header credential at all.
    const headerCredential = hasBasicHeaderCredential(request)
    const credential = yield* credentialFromHeader(request)
    if (ServerAuth.authorized(credential, config)) {
      // Serving valid credentials during an active lockout does not lift it
      // — the throttle targets the brute-forcer, and a legitimate client
      // behind the same address is served anyway. The budget resets only on
      // success outside a lockout.
      if (!limit.blocked) ServerAuth.safely(() => ServerAuth.clearAuthFailures(key))
      return yield* effect
    }
    if (!headerCredential) {
      const token = url.searchParams.get(AUTH_TOKEN_QUERY)
      if (token) {
        // The mint endpoint takes actual Basic header credentials only: no
        // ticket — whatever its scope — may ever mint its own replacement,
        // so the query-ticket fallback never applies there.
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
        return yield* new HttpApiError.Unauthorized({})
      }
    }
    const limited = ServerAuth.rateLimitResponse(limit)
    if (limited) return limited
    ServerAuth.safely(() => ServerAuth.recordAuthFailure(key))
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
    )
    return yield* new HttpApiError.Unauthorized({})
  })
}

export const authorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const cors = yield* CorsConfig

    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (isDisallowedClient(request, cors)) return HttpServerResponse.empty({ status: FORBIDDEN })
        if (!ServerAuth.required(config)) return yield* effect
        const url = new URL(request.url, "http://localhost")
        if (isPublicUIPath(request.method, url.pathname)) return yield* effect
        // Same valid-credentials-pass policy as authorizeCredentials: the
        // lockout throttles brute force, not a legitimate client behind a
        // shared NAT address.
        const realm = ServerAuth.authRealm(config)
        const limit = ServerAuth.authRateLimitStatus(request, realm)
        // Same header-first precedence as authorizeCredentials: valid Basic
        // credentials ignore any query token; the ticket channel is a fallback
        // only for requests without a Basic header credential.
        const headerCredential = hasBasicHeaderCredential(request)
        const credential = yield* credentialFromHeader(request)
        if (ServerAuth.authorized(credential, config)) {
          // Same serve-but-keep-the-lockout policy as authorizeCredentials.
          if (!limit.blocked) {
            ServerAuth.safely(() => ServerAuth.clearAuthFailures(ServerAuth.authFailureKey(request, realm)))
          }
          return yield* effect
        }
        if (!headerCredential) {
          const token = url.searchParams.get(AUTH_TOKEN_QUERY)
          if (token) {
            // This router middleware is mounted only on the browser navigation
            // surface (GET /doc and the web UI catch-all), where headers cannot
            // be set, so every path it guards is inside the url-auth scope.
            // The mint endpoint is excluded anyway: a ticket must never mint
            // its own replacement on any surface.
            if (url.pathname !== TICKET_MINT_PATH && ticketAuthorized(token, "url-auth")) {
              if (!limit.blocked) {
                ServerAuth.safely(() => ServerAuth.clearAuthFailures(ServerAuth.authFailureKey(request, realm)))
              }
              return yield* effect
            }
            const limited = ServerAuth.rateLimitResponse(limit)
            if (limited) return limited
            return ticketRejection(request, realm)
          }
        }
        const limited = ServerAuth.rateLimitResponse(limit)
        if (limited) return limited
        return basicRejection(request, realm)
      })
  }),
)

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const cors = yield* CorsConfig
    if (!ServerAuth.required(config)) return Authorization.of((effect) => guardClientOrigin(effect, cors))
    return Authorization.of((effect) => guardClientOrigin(authorizeCredentials(effect, config), cors))
  }),
)

export const ptyConnectAuthorizationLayer = Layer.effect(
  PtyConnectAuthorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const cors = yield* CorsConfig
    if (!ServerAuth.required(config)) return PtyConnectAuthorization.of((effect) => guardClientOrigin(effect, cors))
    return PtyConnectAuthorization.of((effect) =>
      guardClientOrigin(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
          // credential checks here; the connect handler consumes and validates the ticket.
          if (hasPtyConnectTicketURL(new URL(request.url, "http://localhost"))) return yield* effect
          return yield* authorizeCredentials(effect, config)
        }),
        cors,
      ),
    )
  }),
)
