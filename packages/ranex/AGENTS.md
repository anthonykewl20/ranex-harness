# opencode database guide

## Database

- **Schema**: Drizzle schema lives in `packages/core/src/**/*.sql.ts`.
- **Migrations**: database migrations live in `packages/core` and are applied by core.

## Development server

- Running `bun dev` from `packages/opencode` starts the live interactive TUI. Do not run it as a blocking foreground command when you need to inspect the result.
- Start it in `tmux` instead: `tmux new-session -d -s opencode-dev 'bun dev'`.
- Capture the current TUI output with: `tmux capture-pane -pt opencode-dev`.
- Stop the session explicitly when done: `tmux kill-session -t opencode-dev`.

# Module shape

Do not use `export namespace Foo { ... }` for module organization. It is not
standard ESM, it prevents tree-shaking, and it breaks Node's native TypeScript
runner. Use flat top-level exports combined with a self-reexport at the bottom
of the file:

```ts
// src/foo/foo.ts
export interface Interface { ... }
export class Service extends Context.Service<Service, Interface>()("@opencode/Foo") {}
export const layer = Layer.effect(Service, ...)
export const defaultLayer = layer.pipe(...)

export * as Foo from "./foo"
```

Consumers import the namespace projection:

```ts
import { Foo } from "@/foo/foo"

yield * Foo.Service
Foo.layer
Foo.defaultLayer
```

Namespace-private helpers stay as non-exported top-level declarations in the
same file — they remain inaccessible to consumers (they are not projected by
`export * as`) but are usable by the file's own code.

## When the file is an `index.ts`

If the module is `foo/index.ts` (single-namespace directory), use `"."` for
the self-reexport source rather than `"./index"`:

```ts
// src/foo/index.ts
export const thing = ...

export * as Foo from "."
```

## Multi-sibling directories

For directories with several independent modules (e.g. `src/session/`,
`src/config/`), keep each sibling as its own file with its own self-reexport,
and do not add a barrel `index.ts`. Consumers import the specific sibling:

```ts
import { SessionRetry } from "@/session/retry"
import { SessionStatus } from "@/session/status"
```

Barrels in multi-sibling directories force every import through the barrel to
evaluate every sibling, which defeats tree-shaking and slows module load.

# opencode Effect rules

Use these rules when writing or migrating Effect code.

See `specs/effect/migration.md` for the compact pattern reference and examples.

## Core

- Use `Effect.gen(function* () { ... })` for composition.
- Use `Effect.fn("Domain.method")` for named/traced effects and `Effect.fnUntraced` for internal helpers.
- `Effect.fn` / `Effect.fnUntraced` accept pipeable operators as extra arguments, so avoid unnecessary outer `.pipe()` wrappers.
- Use `Effect.callback` for callback-based APIs.
- Use `Effect.void` instead of `Effect.succeed(undefined)` or `Effect.succeed(void 0)`.
- Prefer `DateTime.nowAsDate` over `new Date(yield* Clock.currentTimeMillis)` when you need a `Date`.

## Module conventions

- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

## Schemas and errors

- Use `Schema.Class` for multi-field data.
- Use branded schemas (`Schema.brand`) for single-value types.
- Use `Schema.TaggedErrorClass` for typed errors.
- Use `Schema.Defect` instead of `unknown` for defect-like causes.
- In `Effect.gen` / `Effect.fn`, prefer `yield* new MyError(...)` over `yield* Effect.fail(new MyError(...))` for direct early-failure branches.

## Runtime vs InstanceState

- Use `makeRuntime` (from `src/effect/run-service.ts`) for all services. It returns `{ runPromise, runFork, runCallback }` backed by a shared `memoMap` that deduplicates layers.
- Use `InstanceState` (from `src/effect/instance-state.ts`) for per-directory or per-project state that needs per-instance cleanup. It uses `ScopedCache` keyed by directory — each open project gets its own state, automatically cleaned up on disposal.
- If two open directories should not share one copy of the service, it needs `InstanceState`.
- Do the work directly in the `InstanceState.make` closure — `ScopedCache` handles run-once semantics. Don't add fibers, `ensure()` callbacks, or `started` flags on top.
- Use `Effect.addFinalizer` or `Effect.acquireRelease` inside the `InstanceState.make` closure for cleanup (subscriptions, process teardown, etc.).
- Use `Effect.forkScoped` inside the closure for background stream consumers — the fiber is interrupted when the instance is disposed.
- To make a service's `init()` non-blocking, fork `InstanceState.get(state)` at the `init()` call site (e.g. `Effect.forkIn(scope)`), not by forking work inside the `InstanceState.make` closure. Forking inside the closure leaves state incomplete for other methods that read it.
- `src/project/bootstrap.ts` already wraps every service `init()` in `Effect.forkDetach`, so `init()` is fire-and-forget in production. Keep `init()` methods synchronous internally; the caller controls concurrency.

## Effect v4 beta API

- `Effect.fork` and `Effect.forkDaemon` do not exist. Use `Effect.forkIn(scope)` to fork a fiber into a specific scope.

## Preferred Effect services

- In effectified services, prefer yielding existing Effect services over dropping down to ad hoc platform APIs.
- Prefer `FileSystem.FileSystem` instead of raw `fs/promises` for effectful file I/O.
- Prefer `ChildProcessSpawner.ChildProcessSpawner` with `ChildProcess.make(...)` instead of custom process wrappers.
- Prefer `HttpClient.HttpClient` instead of raw `fetch`.
- Prefer `Path.Path`, `Config`, `Clock`, and `DateTime` when those concerns are already inside Effect code.
- For background loops or scheduled tasks, use `Effect.repeat` or `Effect.schedule` with `Effect.forkScoped` in the layer definition.

## Effect.cached for deduplication

Use `Effect.cached` when multiple concurrent callers should share a single in-flight computation rather than storing `Fiber | undefined` or `Promise | undefined` manually. See `specs/effect/migration.md` for the full pattern.

## Callback boundaries

Use `EffectBridge` for native or external callbacks (`@parcel/watcher`, `node-pty`, native `fs.watch`, plugin callbacks, etc.) that need to re-enter Effect services with instance/workspace context.

Plain async code should pass explicit context or stay inside an Effect fiber; do not add ambient instance context shims.

## GitHub Tools

Three built-in tools for managing GitHub issues, milestones, and Projects (v2):
`github_issue`, `github_milestone`, `github_project`.

### Setup

The tools resolve credentials in this order:
1. Environment variable (`GH_TOKEN`/`GITHUB_TOKEN` for github.com; `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` for enterprise hosts)
2. `~/.config/gh/hosts.yml` entry for the host
3. `~/.config/opencode/github-token` file (github.com only)
4. `gh auth token --hostname <host>` (system keyring — works automatically if `gh` CLI is authenticated)

The host is derived from `GH_HOST` or the git origin remote.

If none are available, tool calls fail with `AuthMissing`. The token needs `repo` scope
for issues and milestones; add `project` scope for Projects v2 operations.

### Default Repository

`github_issue` and `github_milestone` default `owner`/`repo` from the current git
repository's `origin` remote. Override explicitly by passing both `owner` and `repo`
in the operation. `github_project` always requires an explicit `owner` (the org or
user that owns the project).

### Permission Model

All operations require user approval. Permission patterns:

- `issues:read:owner/repo` / `issues:write:owner/repo`
- `milestones:read:owner/repo` / `milestones:write:owner/repo`
- `projects:read:owner` / `projects:write:owner`

Configure durable allows in `opencode.json`:

```json
{ "permission": { "github": { "issues:read:acme/*": "allow" } } }
```

### Rate Limits

API calls that hit GitHub rate limits (HTTP 429 or 403 with "rate limit" in the
message) are automatically retried once after a 60-second delay.

## Kernel Tools

The `kernel_run` and `kernel_verdict` bridge tools talk to the ranex-kernel —
a separate repository that records governed evidence and publishes signed
verdicts (kernel ADR-019). The bridge is subprocess-only: the harness never
imports kernel code and never judges anything itself.

### Kernel location

Kernel discovery, in order:

1. `kernel.path` in trusted config layers only (global config, `RANEX_CONFIG`,
   `RANEX_CONFIG_CONTENT`). Project-level configs are sanitized — the `kernel`
   section is stripped before parse, so a repository cannot name its own judge.
2. The `RANEX_KERNEL` environment variable.

The resolved path must be absolute, must exist, and must resolve OUTSIDE both
the current session worktree and the harness repository — a kernel the observed
session can edit would judge its own editor. An unset, relative, missing, or
inside-worktree/harness location is a typed refusal (`KERNEL_PATH_UNSET`,
`KERNEL_PATH_RELATIVE`, `KERNEL_PATH_MISSING`, `KERNEL_PATH_INSIDE_WORKTREE`,
`KERNEL_PATH_INSIDE_HARNESS`), never a skip. A blank value counts as unset.

### Verdict production is operator-only

`kernel_verdict` only READS signed verdict files under
`governance/verdicts/<subject-digest>.json`. Producing a verdict — running the
kernel's `gate evaluate` — is the operator's act: no harness code path invokes
it or parses its output. A read yields one of a total set of states (absent,
unverified, unknown-producer, wrong-type, subject-mismatch, freshness-unproven,
unclassified); absence is its own blocking state and is never rendered as a
pass.
