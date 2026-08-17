# Security

## Threat model

ranex-harness is an AI agent runtime providing tools for shell execution, file
operations, and web access.

## No sandbox

The harness does **not** sandbox the agent. The permission system is a UX
feature that prompts before commands, edits, and writes; it is not security
isolation. For true isolation, run the harness in a container or virtual
machine.

Process-level confinement of the bound command is the Ranex kernel's ADR-006
program (SLICE-017+), not yet in production. Until then, treat the agent's
environment as trusted-by-necessity, not enforced-trusted.

## Server mode

Server mode is opt-in. When enabled, set `RANEX_SERVER_PASSWORD` to require
HTTP Basic Auth. Without it, the server runs unauthenticated with a warning.
Securing the server is the operator's responsibility, and functionality it
intentionally provides is not a vulnerability.

## Local API enforcement

- Non-loopback binds require `RANEX_SERVER_PASSWORD`; the harness refuses to
  listen on a non-loopback interface without authentication.
- Host and Origin headers are enforced: IP literals are trusted (they cannot
  be rebound), `localhost` is trusted, and other hostnames require explicit
  operator allowlisting — defeating DNS rebinding against the local API.
- PTY WebSocket endpoints validate the request origin (same-host or
  allowlisted) and use scoped connect tickets.
- Password comparison hashes both sides and compares digests with
  `timingSafeEqual`, so it is constant-time and leaks neither contents nor
  length.
- URL authentication uses short-lived stateless tickets instead of long-lived
  Basic credentials: `auth_token=<ticket>` accepts only
  `payload + "." + base64url(hmacSha256(K, payload))`, where `payload`
  is the base64url encoding of `scope + ":" + decimal expiry Unix seconds`
  and `K` is a 32-byte random process-local secret generated on first use —
  never the Basic password, so a leaked ticket is not an offline
  password-guessing verifier. The HMAC is computed over that exact payload
  segment text (never over the raw values and never re-encoded) — with a
  10-minute TTL, verified by recomputing the HMAC with the process secret
  (`timingSafeEqual`), rejecting unknown scopes, and decoding the payload to
  check the expiry. Tickets are ephemeral per-process credentials: a process
  restart invalidates every outstanding ticket, and URL clients re-mint with
  Basic credentials.
  Tickets are minted by `POST /api/ticket`, which accepts actual Basic
  credentials in the `Authorization` header only — the `auth_token` query
  fallback never applies to the mint endpoint, so no ticket (whatever its
  scope) can mint its own replacement. Raw Basic credentials in the URL are
  rejected with 401 and a `WWW-Authenticate` hint directing clients to the
  `Authorization` header — no in-repo client depends on Basic-in-URL.
- Tickets are scope-bound. `scope` is part of the MAC-covered payload, so a
  client cannot rewrite it. Two values exist: `url-auth` (the default at
  mint time) authorizes the query channel only on the endpoints whose
  channel cannot carry an Authorization header — the SSE event stream
  (`/event`, `/api/event`), the PTY WebSocket connect paths
  (`/pty/:id/connect`, `/api/pty/:ptyID/connect`), and the web UI navigation
  surface (`/` and the `/doc`/catch-all routes the router middleware
  guards) — while `api` (explicit opt-in via the mint request's `scope`
  field) is accepted on the query channel anywhere. A ticket presented via
  URL on an endpoint outside its scope is rejected with 401 exactly like an
  invalid ticket. The Authorization-header Basic path is never
  ticket-gated: header credentials stay full-API. Reuse of one ticket on
  in-scope endpoints within its TTL is by design — SSE reconnects re-present
  the same ticket until it expires.
- The Authorization header credential is evaluated first: a request holding
  valid Basic credentials proceeds regardless of any `auth_token` query
  parameter (recording no authentication failure), and the query ticket is a
  fallback only for requests without Basic header credentials — so a garbage
  query token cannot reject or rate-charge a client with valid Basic
  credentials.
- Failed authentication is rate limited per listener realm + client IP
  (in-memory, 5 failures per 15-minute window, capped at 10k clients): the
  realm derives from the listener's configured credentials, so independent
  listeners in one process never pollute each other's lockout state.
  Further invalid attempts receive 429 with `Retry-After` until the lockout
  passes — but requests presenting valid credentials (Basic or ticket) are
  served even during an active lockout, so brute-force throttling stays
  while a legitimate client behind a shared NAT address is not locked out;
  serving valid credentials does not lift the lockout. Lockouts escalate
  exponentially — each consecutive lockout doubles the next one's duration
  (15m, 30m, 1h, ... capped at 24h) — and a successful authentication
  outside an active lockout resets both the failure count and the
  escalation. `Retry-After` reflects the
  actual remaining lockout with ±20% jitter applied to the advertised value
  only (the internal state stays exact). Requests without a remote address
  (in-process web handler conversions) are keyed by an Authorization-header
  digest instead. The limiter is best-effort and fails open — an internal
  error never wedges authentication.

## Request body limits

Both HTTP stacks reject requests whose `content-length` header exceeds
50 MB (override with `RANEX_MAX_BODY_BYTES`) with 413 before any handler
runs. For bodies without a usable `content-length` — including chunked
uploads — the limit middleware also installs the Effect platform
`MaxBodySize` fiber reference at the same cap: the Node server adapters
count bytes during every buffered body read (text/JSON/arrayBuffer, and
multipart totals) and destroy the request stream mid-read once the cap is
crossed, surfacing as a 413 or an aborted connection. Residuals: handlers
that stream the raw request body (the workspace proxy) are not byte-capped
at the forwarding hop — the proxied instance enforces the same cap itself —
and the in-process web handler (loopback `fetch` from the same process
only) does not route body reads through the Node adapters.

## Heap snapshots

Heap snapshots — taken automatically when RSS crosses the
`RANEX_AUTO_HEAP_SNAPSHOT` threshold (tunable via
`RANEX_HEAP_SNAPSHOT_RSS_BYTES` / `RANEX_HEAP_SNAPSHOT_INTERVAL_MS`), or on
the manual triggers — the `app.heap_snapshot` TUI command ("Write heap
snapshot" in `packages/tui/src/app.tsx`) and the snapshot RPC in
`packages/ranex/src/cli/tui/worker.ts` — capture the process's entire heap,
including in-memory secrets such as credentials and
API keys. They are written as `0600` files with absolute timestamped names
under the app's log directory (`~/.local/share/ranex/log` by default) and are
never overwritten; treat every snapshot file as highly sensitive and delete
it as soon as debugging is done.

## Proxy and catch-all hardening

- `ProxyUtil.headers` strips end-client credentials (`authorization`,
  `cookie`, `x-api-key`, `x-auth-token`) alongside hop-by-hop headers, so
  forwarded requests never carry the client's credentials upstream.
- The web UI catch-all serves only `GET`/`HEAD` on non-`/api` paths;
  anything else (including unmatched `/api` paths and all mutating methods)
  returns 404 instead of being proxied to `app.opencode.ai`.

## Untrusted project config

`ranex.json` and project `.opencode/` config come from the repository being
worked on and are treated as untrusted:

- Credential- and redirect-bearing provider fields are stripped at load:
  `provider.<id>.api`, `provider.<id>.npm`, the `apiKey`, `authToken`,
  `baseURL`, `headers`, and `enterpriseUrl` provider options, and the
  model-level `headers` / `provider.api` / `provider.npm` equivalents.
- `experimental.openTelemetry` and `experimental.policies` are stripped from
  project sources: the former turns on prompt/completion telemetry export,
  and policies are permission-adjacent (an `allow` policy statement can
  grant actions on resources), so project sources must not grant. Both stay
  available from global-scope config. Project-scope `experimental.policies`
  is ignored by both the ranex and core config loaders.
- `{env:}` and `{file:}` substitution is inert for project sources — tokens
  stay literal. Substitution (including MCP header `{env:VAR}` expansion)
  works only in global-scope config, so secrets can only be referenced where
  the user placed them.
- Project-scoped MCP entries cannot set `inheritEnv`.
- Remote MCP entries in project config are accepted by design: the repo
  author is choosing a data channel for tool traffic, the same as choosing
  an LLM provider endpoint, and no user credentials flow to them (local
  stdio servers run with an allowlisted environment, and forwarded HTTP
  headers are controlled by the user's global config, not the repo).
- The automatic `@ranex/plugin` install is skipped when a repo-controlled
  `.npmrc` exists on the config path, since it could redirect the install.

## webfetch SSRF posture

The webfetch tool refuses private, reserved, and loopback targets at URL
syntax level, and the transport pins validation at connection time: the
node http `lookup` option is a validated resolver
(`packages/core/src/util/secure-http.ts` `validatedNodeLookup`), so the
socket can only ever connect to addresses that already passed the same
IP-range checks — a rebinding DNS that answers differently than any earlier
lookup is refused at the connection, not just pre-flight. Resolution
failure fails closed. Redirects are followed manually and every hop is
re-validated, with at most 5 hops. Intentional intranet fetching is not
currently supported.

## MCP server environment

Local (stdio) MCP servers run with an allowlisted environment, not the full
parent process environment, so provider API keys do not leak to them.
`inheritEnv: true` on a local entry — honored from global config only, never
project config — restores full inheritance.

## Permission system posture

The permission system is a prompt UX, not a sandbox (see above). Within it:

- Bash approval rules never match when either side carries shell control
  characters (`;|&`, backticks, newline, `$()`, `<>`), so compound or piped
  commands cannot inherit a prefix approval.
- `evaluate()` matches resource casing effect-aware: on POSIX, `allow` rules
  match resource casing strictly so `allow Secrets/*` cannot widen to
  `secrets/x`, while `deny`/`ask` rules match case-insensitively so a casing
  change cannot bypass a denial; win32 is case-insensitive throughout.
- The legacy ranex wildcard copy (`packages/ranex/src/util/wildcard.ts`) is
  pinned to tool-name matching only — its case handling is not
  effect-aware. Resource and permission pattern matching (file paths,
  commands) must go through `@ranex/core/util/wildcard`; the pin is a
  test-enforced invariant.
- Plan mode's bash policy is ask-by-default with read-only inspection
  commands allowlisted and known-mutating `git`/`gh` commands flat-denied.
- The default agents' `* * allow` ruleset is deliberate: an accepted,
  user-configurable posture (users are expected to tighten permission rules
  to their own risk tolerance), not an oversight.

## Supply chain

- The `install` script verifies the downloaded archive against the release's
  `SHA256SUMS` (same release channel) and aborts before extraction on a
  missing manifest, a missing entry, or a checksum mismatch. Same-channel
  checksums protect against corruption and one-sided tampering (an attacker
  who controls the archive or the manifest, but not both) — not against an
  attacker who controls both archive and manifest, since they ship from the
  same channel.
- Optionally, setting `OPENCODE_INSTALL_PUBKEY` (a key pinned outside the
  release channel) additionally requires a detached Ed25519 signature over
  the archive before extraction: the format used — `.sig` (raw, via openssl
  >= 1.1.1) or `.minisig` (via minisign) — is selected from what the release
  publishes intersected with the verifiers actually installed, and a release
  publishing no verifiable format aborts the install.
- Every `bunfig.toml` `minimumReleaseAgeExcludes` entry bypasses the 3-day
  publish-delay control; each entry requires a documented reason, and any
  addition mandates re-review of the whole list (see `bunfig.toml`).
- The MCP SDK patch (`patches/@modelcontextprotocol*`) carries
  security-relevant behavior and must be re-reviewed on every version bump.

## Residual known risks

- **git clean/smudge filters**: operations on a discovered (e.g. copied)
  repository can still trigger `clean`/`smudge` filters defined in that
  repo's `.git/config`. Documented and only partially mitigated. For
  discovered repos, git invocations additionally run with
  `-c core.fsmonitor=false -c gc.auto=0 -c core.hooksPath=/dev/null
  -c credential.helper=` (a configured `core.fsmonitor` command can no
  longer execute; hooks such as post-checkout/pre-commit are disabled for
  these invocations; the empty `credential.helper` resets the inherited
  helper list so a fake helper in the copied repo's config never receives
  credentials — unauthenticated fetches of public remotes still work; the
  snapshot repository keeps its isolated gitdir behavior), and tree IDs
  (`[0-9a-f]{4,64}`) and refnames are validated before reaching git argv.
  The filter residual stands: a hostile worktree's `.gitattributes` can
  select `filter.<name>` drivers defined in the repo's own `.git/config`,
  and `filter.<name>.*` keys cannot be wildcard-disabled via `-c`, so this
  is mitigated only by the snapshot repository's isolation.
- **Same-channel install checksums**: `SHA256SUMS` and the archive ship from
  the same release; an attacker controlling both archive and manifest defeats
  the check.
- **DNS rebinding**: fully mitigated only at the webfetch transport; other
  hypothetical egress paths are not checked.

## Out of scope

| Category                        | Rationale                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| **Server access when opted-in** | If you enable server mode, API access is expected behavior              |
| **Sandbox escapes**             | The permission system is not a sandbox                                  |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior**         | External MCP servers you configure are outside our trust boundary       |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector    |

## Reporting security issues

Report vulnerabilities through the repository's
[GitHub Security Advisory](https://github.com/anthonykewl20/ranex-harness/security/advisories/new)
page.
