# Final — Complete Polished Experience

Everything in `v1.md`, plus dedicated TUI rendering, error-handling polish, and optional CLI subcommands. HTTP API remains out of scope (revisit only if external programmatic access is needed).

## Additions over v1

| Concern | final |
|---|---|
| TUI rendering | Dedicated renderers per tool + dedicated `github` permission renderer |
| Error handling | Rate-limit detection + retry/backoff; typed errors surfaced to the model; partial-failure handling for Projects |
| Auth | `GITHUB_TOKEN` + `Auth.Service.get("github")` (stored in `auth.json`); optional OAuth device flow as a later addition |
| CLI subcommands | `ranex github issue|milestone|project ...` calling the same `GitHub.Service` |
| HTTP API | still deferred |

## TUI polish (Milestone 7)

### Permission renderer (M7.1)

`packages/tui/src/routes/session/permission.tsx` `info()` (around lines 195-381) currently has a fallback branch (lines 372-380) rendering `" Call tool <permission>"`. Add a dedicated `github` branch before the fallback that builds a semantic title from `metadata.action`, `metadata.owner`, `metadata.repo`:

- `create` issue → ` ambulance Create issue in \`acme/widgets\``
- `close` issue → ` ambulance Close #427 in \`acme/widgets\``
- `list` issues → ` ambulance List issues in \`acme/widgets\``
- `set_field` project → ` archite Set \`Status\` to \`In Progress\``

The body shows the operation payload summary (title for create, field name + value for set_field). Never include the token.

### Tool renderers (M7.2-M7.4)

`packages/tui/src/routes/session/index.tsx` dispatches via `toolDisplay(part.tool)` (lines 639-641) to a per-tool renderer in `PART_MAPPING` (lines 1725-1771). Unknown ids fall through to `GenericTool`. Add three renderers matching the inline style of `WebFetch` (index.tsx:2188-2194):

- **`GitHubIssue`**: reads `metadata.action`, `metadata.count`, `metadata.number`, `metadata.url`, `metadata.owner`, `metadata.repo`.
  - `list` → ` ambulance 12 open issues in acme/widgets `
  - `create` → `-issue #427  Create login retry ` (number + url from metadata)
  - `close` → `-issue #427 closed `
- **`GitHubMilestone`**: reads `metadata.action`, `metadata.number`, open/closed counts.
  - `list` → ` ambulance 4 milestones `
  - `create` → `-Milestone #12  v2.0 launch `
- **`GitHubProject`**: reads `metadata.action`, `metadata.number`, field name/value.
  - `list` → ` ambulance 3 projects `
  - `set_field` → `-Project Roadmap  Status → In Progress `

These consume known `metadata` keys exactly the way `TodoWrite` reads `metadata.todos` (`index.tsx:2513`) or `Grep` reads `metadata.count` (`index.tsx:2181`).

## Error handling polish (Milestone 8)

### Rate limit detection and retry (M8.1)

`packages/ranex/src/github/` gains a shared request wrapper that:

1. Detects 403/429 with header `x-ratelimit-remaining: 0`.
2. Reads `x-ratelimit-reset` (unix seconds); sleeps until reset (capped at 60s); retries once.
3. On secondary rate limit (the `retry-after` header), honors it directly.
4. Surfaces remaining quota in `metadata` on success (e.g. `metadata.rateLimitRemaining`).
5. On exhausted retry, raises `RateLimitError` with the reset time so the model can back off.

### Typed errors to the model (M8.2)

Translate `GitHubError` subtypes into model-visible failure prose via the runner's `ToolFailure` path. The agent should see:

- `Issue #999 not found in acme/widgets` (not a stack trace)
- `Missing scope: repo` (when the token lacks permissions)
- `Field "Status" is ambiguous; options: Status, Status v2` (when project field resolution is ambiguous)

### Projects partial failures (M8.3)

`set_field` is multi-step: resolve project node ID → resolve field metadata → resolve option ID → mutate. Report exactly which step failed without leaking credentials. If field metadata resolves but the mutation fails, surface the resolved field name + the failure reason so the agent can retry with corrected input.

## CLI subcommands (Milestone 9, optional)

Under `packages/ranex/src/cli/cmd/github/`. Each subcommand calls the same `GitHub.Service` — no parallel implementation. Follow the existing `effectCmd` pattern (`packages/ranex/src/cli/cmd/github.ts`).

```
ranex github issue list [--state open|closed|all] [--labels l1,l2]
ranex github issue get <number>
ranex github issue create --title <t> [--body <b>] [--milestone <n>]
ranex github issue close <number>
ranex github milestone list
ranex github milestone create --title <t> [--due <date>]
ranex github project list --owner <org|user>
ranex github project add-item <number> --issue <owner/repo#num>
ranex github project set-field <number> --field <name> --value <v>
```

Mutations require `--yes` or an interactive confirmation prompt. Reads do not.

The existing `ranex github install` and `ranex github run` commands (the Action runner) stay under `ranex github` unchanged; these new subcommands live alongside them.

## Auth extensions (post-v1)

After `GITHUB_TOKEN`-only v1:

1. `Auth.Service.get("github")` — store a PAT in `auth.json` via the existing secure mechanism (`packages/ranex/src/auth/`). Resolution order: `GITHUB_TOKEN` env → `Auth.Service.get("github")`.
2. Optional OAuth device flow — a separate GitHub OAuth App registration; out of scope until a concrete user workflow needs it.

`gh auth token` fallback was considered and rejected (Terra's stricter recommendation): spawning a child process to extract a secret is not worth the surface area for v1 or the final scope unless a concrete need appears.

## Still out of scope

- HTTP API routes (public SDK surface; revisit only for external programmatic access).
- Releases, PRs, Actions, teams, secrets, repository administration, webhook management.
- GitHub Enterprise-specific behavior (untested; not blocked, just unverified).
