# GitHub Integration

Native GitHub issues, milestones, and Projects (v2) integration for the ranex agent. Direct customization of the ranex CLI — no MCP.

> **Status (2026-08-15): shipped.** The `packages/ranex/src/github/` foundation
> and the three built-in tools (`github_issue`, `github_milestone`,
> `github_project`) are in production. The shipped credential-resolution
> order, default-repo behavior, permission patterns, and rate-limit retry are
> documented in the "GitHub Tools" section of `packages/ranex/AGENTS.md`,
> which supersedes the v1-only details below. The milestones and issues
> section remains the plan of record for unfinished work.

## Goal

Let the interactive ranex agent create, list, update, and close GitHub issues, milestones, and Projects (v2) items as first-class built-in tools, with permission gating and rich TUI rendering.

This is a DIRECT native customization written into the ranex repo itself. The existing MCP infrastructure (`packages/ranex/src/mcp/`) is intentionally not used.

## Architecture Decision

Architecture **D** — consensus of the `consensus-luna` and `consensus-terra` reviewers (2026-08-12):

- A shared native domain service `packages/ranex/src/github/` owns authenticated Octokit (REST + GraphQL) clients per-instance via `InstanceState`.
- Three built-in agent tools (`github_issue`, `github_milestone`, `github_project`) expose the service to the model via `Tool.define`.
- CLI subcommands and HTTP API routes are deferred to the final phase (see `final.md`).

### Why not the alternatives

- **MCP**: rejected by the user. Direct customization only.
- **CLI-only**: does not serve the agent workflow. The agent needs callable tools, not just human commands.
- **HTTP API first**: public SDK surface that triggers client regeneration, a separate remote-caller authorization problem, and no fit for `ctx.ask`. Revisit only if external programmatic access becomes a concrete requirement.

## Upstream Verification (2026-08-12)

Verified directly against the installed artifact `node_modules/.bun/@octokit+plugin-rest-endpoint-methods@16.1.1/.../dist-src/generated/endpoints.js`:

- Issues: `/repos/{owner}/{repo}/issues` plus comments, reactions, assignees, events.
- Milestones: `/repos/{owner}/{repo}/milestones` plus labels.
- Projects v2: `/orgs/{org}/projectsV2`, `/users/{username}/projectsV2`, `/users/{user_id}/projectsV2`, each with `/fields` and `/items` sub-routes.

Both reviewers corrected the initial premise that "Projects v2 is GraphQL-only": REST `projectsV2` endpoints ship in `@octokit/rest@22.0.0`. GraphQL remains useful for rich single-select field option mutations.

Installed versions: `@octokit/rest@22.0.0`, `@octokit/graphql@9.0.2`.

## Upstream References

- Issues REST: https://docs.github.com/en/rest/issues/issues
- Milestones REST: https://docs.github.com/en/rest/issues/milestones
- Projects v2 REST: https://docs.github.com/en/rest/projects/projects
- Projects v2 GraphQL: https://docs.github.com/en/graphql/reference/projects
- Octokit REST: https://github.com/octokit/rest.js
- Octokit GraphQL: https://github.com/octokit/graphql.js

## Module Layout

```
packages/ranex/src/github/
  github.ts          # GitHub.Service — Context.Service + LayerNode, per-instance via InstanceState
  auth.ts            # resolveToken(): GITHUB_TOKEN env (required for v1)
  repository.ts      # resolveOwnerRepo(): parse origin via Git.Service + parseGitHubRemote
  issues.ts          # issue operation handlers (take Octokit, return normalized data)
  milestones.ts      # milestone operation handlers
  projects.ts        # project operation handlers (REST + GraphQL)
  error.ts           # GitHubError, AuthMissing, RepoNotResolved (Schema.TaggedErrorClass)
packages/ranex/src/tool/github/
  issue.ts           # github_issue tool (Tool.define)
  milestone.ts       # github_milestone tool
  project.ts         # github_project tool
  issue.txt          # description sidecars (markdown, sent to the LLM via AI SDK tools map)
  milestone.txt
  project.txt
```

Wiring: add the three tools to `packages/ranex/src/tool/registry.ts` builtin array (around the existing `Effect.all` block at lines 202-240).

## Milestones and GitHub Issues

When the GitHub integration is functional, create these milestones and issues in the `ranex-harness` repo to track remaining work. Each milestone is a GitHub Milestone; each `Mx.y` is a GitHub Issue. Issue titles use conventional-commit style per `AGENTS.md`.

### Milestone 1 — Foundation: `GitHub.Service` domain layer (v1)

- **M1.1** `feat(github): add GitHub.Service with auth and repo resolution`
  - Create `packages/ranex/src/github/github.ts`: `GitHub.Service` via `Context.Service<Service, Interface>()("@opencode/GitHub")`, constructed in `InstanceState.make` so each open project gets its own clients and default repo.
  - Create `packages/ranex/src/github/auth.ts`: `resolveToken()` reads `GITHUB_TOKEN` env var; throws `AuthMissing` if absent. Never accept a token as a tool argument or log it.
  - Create `packages/ranex/src/github/repository.ts`: `resolveOwnerRepo({ owner?, repo? })` returns the explicit override if complete; otherwise resolves `origin` from `Git.Service.run(["remote","get-url","origin"])` and parses via `parseGitHubRemote` (in `@/util/repository`). Throws `RepoNotResolved` on partial override or non-GitHub remote.
  - Create `packages/ranex/src/github/error.ts`: `GitHubError` (base), `AuthMissing`, `RepoNotResolved`, `ApiError` as `Schema.TaggedErrorClass`.
  - Wire `GitHub.node` (`LayerNode.make` with `deps: [Config.node, Git.node]`) into instance bootstrap.
  - **Acceptance**: `bun typecheck` passes from `packages/ranex`; service constructs `Octokit` + `graphql.defaults` with the resolved token; missing token raises `AuthMissing`; non-git directory raises `RepoNotResolved`.
  - **Dependencies**: none.

- **M1.2** `feat(github): add issue operation handlers`
  - Create `packages/ranex/src/github/issues.ts` with pure handlers: `list`, `get`, `create`, `update`, `close`, `comment`.
  - Back each with `octokit.rest.issues.*` (list, get, create, update, createComment). `close` = update with `state: "closed"`.
  - Return normalized `IssueInfo` (`Schema.Struct` with number, title, state, url, body, labels, assignees, milestone, createdAt, updatedAt).
  - **Acceptance**: each handler calls the verified REST endpoint; output is snake_case-normalized; pagination on `list` via `octokit.paginate`.
  - **Dependencies**: M1.1.

- **M1.3** `feat(github): add milestone operation handlers`
  - Create `packages/ranex/src/github/milestones.ts`: `list`, `get`, `create`, `update`, `close`.
  - Back with `octokit.rest.issues.listMilestones.*`, `createMilestone`, `updateMilestone`. `close` = update with `state: "closed"`.
  - Return `MilestoneInfo` (number, title, state, description, dueOn, openIssues, closedIssues).
  - **Acceptance**: handlers work against verified endpoints; output normalized.
  - **Dependencies**: M1.1.

- **M1.4** `feat(github): add project operation handlers`
  - Create `packages/ranex/src/github/projects.ts`: `list`, `get`, `add_item`, `set_field`, `create`.
  - REST for `list`/`get`/`create` (`octokit.rest.projects.*` against `/orgs/{org}/projectsV2` and `/users/{username}/projectsV2`). GraphQL for `add_item` (`addProjectV2ItemById`) and `set_field` (resolve field name + option ID via a metadata query, then mutate).
  - `set_field` must reject ambiguous field names and re-resolve field metadata fresh per mutation (field options are mutable server-side).
  - Return `ProjectInfo` (number, title, url, items count) and `ProjectItemInfo` (id, content {type, number, title}, field values).
  - **Acceptance**: REST ops hit verified endpoints; GraphQL mutations use fixed documents with variables (never string-interpolated IDs in the query body); `set_field` resolves names, not raw IDs.
  - **Dependencies**: M1.1.

### Milestone 2 — `github_issue` tool (v1)

- **M2.1** `feat(github): add github_issue tool`
  - Create `packages/ranex/src/tool/github/issue.ts`: `Tool.define("github_issue", ...)` with `Parameters = Schema.Struct({ owner?, repo?, operation: IssueOp })` where `IssueOp` is a tagged union over `list`/`get`/`create`/`update`/`close`/`comment`.
  - Create `packages/ranex/src/tool/github/issue.txt`: markdown description with concrete examples (when to call, what each action returns, how owner/repo defaults work). This text is sent to the LLM via the AI SDK `tools` map — it is how the model learns the tool exists.
  - Permission gate in `execute`: `ctx.ask({ permission: "github", patterns: [\`issues:\${mode}:\${owner}/\${repo}\`], always: [\`issues:\${mode}:\${owner}/\${repo}\`], metadata: { action, owner, repo } })` where `mode` is `read` for `list`/`get` and `write` for the rest.
  - Wire into `packages/ranex/src/tool/registry.ts`: add to the `Effect.all` block and the `builtin` array.
  - **Acceptance**: agent can call `github_issue`; permission prompt fires before any network call; reads default to `ask` (user can configure allow in `opencode.json`); writes always ask; returns `ExecuteResult` with `metadata: { owner, repo, action, count?, url? }`.
  - **Dependencies**: M1.2.

### Milestone 3 — `github_milestone` tool (v1)

- **M3.1** `feat(github): add github_milestone tool`
  - Mirror M2.1 for milestones: `tool/github/milestone.ts` + `milestone.txt`.
  - Permission patterns: `milestones:read:<owner>/<repo>`, `milestones:write:<owner>/<repo>`.
  - **Acceptance**: same shape as M2.1 for milestone operations.
  - **Dependencies**: M1.3.

### Milestone 4 — `github_project` tool (v1)

- **M4.1** `feat(github): add github_project tool`
  - Mirror M2.1 for projects: `tool/github/project.ts` + `project.txt`.
  - Always require explicit `{ owner, number }` for the project target — a project's owner need not match the current repo.
  - Permission patterns: `projects:read:<owner>`, `projects:write:<owner>`.
  - **Acceptance**: agent can list/get/create projects, add items, set named fields; permission prompt shows the project owner + number.
  - **Dependencies**: M1.4.

### Milestone 5 — v1 verification (v1)

- **M5.1** `test(github): add auth and repo resolution tests`
  - Cover: missing `GITHUB_TOKEN` → `AuthMissing`; valid token → clients constructed; explicit owner/repo override used as-is; `origin` fallback via mocked git remote; non-GitHub remote → `RepoNotResolved`; partial override rejected.
  - **Dependencies**: M1.1.

- **M5.2** `test(github): add tool permission gating tests`
  - Cover: reads default to `ask`; writes always ask; `opencode.json` durable allow rule for `issues:read:*` is honored; Reject returns the user message as the tool result.
  - **Dependencies**: M2.1, M3.1, M4.1.

- **M5.3** `test(github): add operation handler tests with recorded fixtures`
  - Record Octokit responses once against a scratch repo; replay as fixtures. Cover each operation in M1.2/M1.3/M1.4.
  - **Dependencies**: M1.2, M1.3, M1.4.

### Milestone 6 — v1 release (v1)

- **M6.1** `docs(github): document v1 tools in AGENTS.md`
  - Add a "## GitHub Tools" section to `packages/ranex/AGENTS.md` describing the three tools, permission model, and `GITHUB_TOKEN` requirement.
  - Note that TUI rendering uses the `GenericTool` fallback in v1; dedicated renderers ship in M7.
  - **Dependencies**: M2.1, M3.1, M4.1.

### Milestone 7 — TUI polish (final)

- **M7.1** `feat(tui): add github permission renderer`
  - In `packages/tui/src/routes/session/permission.tsx` `info()` (around lines 195-381), add a `github` branch that renders the operation semantically: e.g. ` arquitec Create issue in \`acme/widgets\``, ` archite Set Projects field \`Status\` to \`In Progress\``. Build from `metadata.action`, `metadata.owner`, `metadata.repo`.
  - **Dependencies**: M6.1.

- **M7.2** `feat(tui): add github_issue tool renderer`
  - In `packages/tui/src/routes/session/index.tsx` `toolDisplay`/`PART_MAPPING` (around lines 639-641, 1725-1771), add a `GitHubIssue` renderer matching the inline style of `WebFetch` (index.tsx:2188-2194): ` ambulance 12 open issues in acme/widgets ` for list, `-issue #427  Create login retry ` for create (with issue number + URL from metadata).
  - **Dependencies**: M7.1.

- **M7.3** `feat(tui): add github_milestone tool renderer`
  - Mirror M7.2 for milestones: `-Milestone v2.0  3 open / 12 closed `.
  - **Dependencies**: M7.1.

- **M7.4** `feat(tui): add github_project tool renderer`
  - Mirror M7.2 for projects: `-Project Roadmap  Status → In Progress `.
  - **Dependencies**: M7.1.

### Milestone 8 — Error handling polish (final)

- **M8.1** `feat(github): add rate limit detection and retry`
  - Detect 403/429 with `x-ratelimit-remaining: 0`; honor `x-ratelimit-reset`; retry once after backoff; surface remaining quota in metadata on success.
  - **Dependencies**: M6.1.

- **M8.2** `feat(github): surface typed errors to the model`
  - Translate `GitHubError` subtypes into model-visible `ToolFailure` prose so the agent can recover (e.g. "issue number 999 not found" rather than a stack trace).
  - **Dependencies**: M6.1.

- **M8.3** `feat(github): handle partial failures in Projects operations`
  - `set_field` may resolve field metadata but fail the mutation; report exactly which step failed without leaking credentials.
  - **Dependencies**: M1.4.

### Milestone 9 — CLI subcommands (final, optional)

- **M9.1** `feat(cli): add github issue subcommands`
  - Under `packages/ranex/src/cli/cmd/github/`: `ranex github issue list|get|create|update|close|comment`. Each calls the same `GitHub.Service`; mutations require `--yes` or interactive confirm.
  - **Dependencies**: M6.1.

- **M9.2** `feat(cli): add github milestone subcommands`
  - Mirror M9.1 for milestones.
  - **Dependencies**: M6.1.

- **M9.3** `feat(cli): add github project subcommands`
  - Mirror M9.1 for projects.
  - **Dependencies**: M6.1.

## Implementation Order

M1 → M2 → M3 → M4 → M5 → M6 (v1 done) → M7 → M8 → M9 (final done).

Each issue is one `codex` delegation: one coherent change, exact paths, acceptance criteria as the gate. Concurrent issues in the same milestone may need separate worktrees if both mutate shared files.

## Verification (every issue)

- `bun typecheck` from `packages/ranex` (never `tsc` directly, never repo root).
- Tests run from `packages/ranex` (`do-not-run-tests-from-root` guard).
- Style: follow `packages/ranex/AGENTS.md` (no comments, no `any`, Effect patterns, self-reexport modules, no alias/star imports).
