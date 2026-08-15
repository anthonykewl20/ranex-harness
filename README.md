# Ranex Harness

> Rules an agent can read are suggestions. Rules compiled into code are
> constraints.

The agent harness — the model-driven side of Ranex's wall. A trimmed fork of
opencode (MIT), molded so a code-only kernel outside the loop judges every step
by executable evidence.

## The problem

An AI writing software is a blindfolded dart thrower with a guide shouting
coordinates. The thrower cannot see whether its dart landed, and the guide may
have given bad coordinates before the throw. Those are separate failures. A
third is more common:

> Most tools let the thrower paint the bullseye around the dart after it lands.

Today an agent both writes the tests and declares success, so "all tests pass"
means little. The full problem statement lives in the kernel repository.

## The solution

Ranex is `make` for a nondeterministic compiler. It optimizes the **scoring**,
not the aim.

> Ranex does not improve aim. Not by one degree. It makes misses visible and cheap, and hits provable.

A code-only kernel sits outside the agent loop and judges executable evidence,
not model confidence.

> Removing every model credential from the machine must not change a single verdict.

The wall is load-bearing. The harness is model-driven TypeScript. The kernel is
code-only Python. They run as separate processes. Hooks inside the harness
collect references. The kernel outside reads disk, holds keys, writes the
journal, and is the only thing that stamps.

## What this harness is

This repository is the **ranex harness**: the producer on the model-driven side
of the wall. It is not a general-purpose coding agent, and it is not opencode.
It is a deliberately narrowed fork whose output is treated as untrusted until
the separate Ranex kernel measures it.

The molding is concrete:

- **Pinned provenance.** Forked from opencode at `v1.18.11`
  (`012c2f57f976489d88bd4598a056b4bdcdd428ee`, abbreviated `012c2f57`).
  Upstream MIT attribution is retained. This records provenance, not
  affiliation.
- **Keep-set.** `ranex` (core business logic & server), `core`, `cli`, `llm`,
  `plugin`, `protocol`, `schema`, `tui`, `server`, `sdk`,
  `effect-drizzle-sqlite`, plus top-level `patches/`.
- **Cut-set.** Desktop, web, console, infra, and the other upstream packages
  outside the keep-set are cut.
- **Locked plugin surface.** Only compiled-in built-ins may load. Config-driven
  and npm-installed plugins are refused. The bridge is the only loaded plugin.
- **Fail-closed startup.** The harness refuses to start unbridged. A silent,
  unjudged run is a defect, never a default.
- **No producer approval.** The harness never approves, merges, stamps, or
  names the approver. On task end it commits its tree. The kernel materialises
  that commit and judges the bytes itself.

The harness's own summary is discarded. It is never evidence.

> One actor writes the code, writes the tests, and declares success. That is why "all tests pass" from an AI means so little — the target moved to wherever the dart went.

### How the loop closes

```text
take the next ready task
  → create an isolated git worktree
  → spawn a worker
  → wait for it to exit
  → read the DIFF ON DISK (the worker's summary is discarded)
  → run the checks (code, not a model)
  ├─ pass → the kernel merges
  └─ fail → retry ×3, then escalate to the human in plain language
```

Workers never merge — the kernel merges.

## The wall

Producer and gauge are under one roof but separated by a process boundary. If
the wall falls, the restaurant grades its own dishes. Hooks collect; the kernel
judges.

## Status

**Pre-release. This is not a usable product yet.** This is the harness side of
a system whose hardest conceptual part — the verdict path — lives in the
kernel.

This is where ADR-015's durable-execution program runs: milestone #1, "Durable
execution, failover, and recovery." All five of its durability claims are in
production here, and milestone #1 is closed:

- **Provider watchdog** — SLICE-012, `23d6a5b4ee`. A stalled provider stream
  now reaches a terminal state on its own instead of hanging forever.
- **Reconciler reorder and startup sweep** — SLICE-013, `a8bc7bdf35`. A crash
  with an empty inbox no longer strands tools projected `running` forever.
- **Durable retry** — SLICE-014, `2a098d4963`. A retryable provider failure
  persists its attempt and survives a restart.
- **Durable blockers** — SLICE-015, `0aea8a19a7`. Pending permission/question
  waits survive teardown, settle exactly once, and rehydrate without republish.
- **Session-ID fencing** — SLICE-016, `1834c96260`. Cross-process drain
  ownership is claimed and released against a live owner check.

A `v0.1.2 — opportunity backlog` hardening pass layered on top of milestone #1,
scoped from an upstream-opencode audit: durable permission/question blockers
are now Location-scoped (no cross-location settle), cascade on session delete,
and block session moves while pending; retryable in-band provider errors
(Anthropic/OpenAI) enter the bounded retry path; and settlement failures return
typed errors instead of dangling waiters. See milestone #3 and issues #55–#82.
This pass also closed issues #56, #59, #61, and #64: Location lifecycle
teardown is generation-scoped, cold location acquisition is non-blocking, V2
event streams are interest-scoped and byte-bounded with durable recovery, and
every V2 permission/question wait path is durable.

On 2026-08-15 a comprehensive security program closed: a four-surface audit
(execution and permissions, project-config trust, the local API, and the
supply chain — 37 findings, 4 P0 and 9 P1) with fixes shipped across all four
surfaces. Tool path confinement for `grep`/`glob` and a DNS-pinned SSRF guard
behind both `webfetch` tools harden execution; bash control-character guards,
exact-resource saves, effect-aware rule casing, and a plan-mode bash policy
harden permissions; provider credential/npm/model-header strips, inert
`{env:}`/`{file:}` substitution, a `.npmrc` install skip, and
`experimental.openTelemetry`/`experimental.policies` strips in both config
loaders establish the project-config trust boundary; Host/origin enforcement
against DNS rebinding, scope-bound HMAC URL tickets with authenticated mint,
constant-time auth, realm-keyed escalating rate limiting, body caps including
chunked uploads, proxy credential stripping, and a mandatory password for
non-loopback binds (ranex and legacy CLI) harden the local API; and git argv
validation with hooks/credential helpers disabled for discovered repos, 0600
SQLite files, the MCP env allowlist, opt-in-only telemetry content recording
and GitHub-agent sharing, and an optional signed install
(`OPENCODE_INSTALL_PUBKEY`) harden the supply chain.
[SECURITY.md](./SECURITY.md) states the trust model and the residual-risk
list.

The TUI is being redesigned on a **separate track** under ADR-018: "the board
is the front door." It neither consumes the durability program nor changes
kernel authority.

**Known gaps, stated plainly:**

- Same-UID key theft is open (`RISK-06`). Confinement under ADR-006 and
  SLICE-017+ closes it. Until then, use a scoped, spend-limited model key.
- Today's `task fanout` is free-prompt JSONL prototype mechanics, **not**
  production mutation authority. Keep one mutation writer until SLICE-044's
  exit.
- Legacy `/event` and `/global/event` planes remain canonical and unbounded;
  #83 tracks their bounding after the ADR-018 TUI migration.

## Where the kernel lives

The authoritative problem statement, full arc42 architecture map, ADRs, slice
ledger, and current status live in **the Ranex kernel repository**, the sibling
Python project. This harness is out-of-tree relative to it. Harness-side
durability work lands here.

This repository is hosted at
[github.com/anthonykewl20/ranex-harness](https://github.com/anthonykewl20/ranex-harness).
No kernel URL is asserted here until the owner supplies the verified location.

## Development

Requires Bun 1.3 or newer.

```bash
bun install
bun dev
```

`bun dev` runs in `packages/ranex`. To run against another directory:

```bash
bun dev <directory>
```

Typecheck from the affected package, never from the repository root and never
with `tsc` directly:

```bash
cd packages/ranex
bun typecheck
```

Tests cannot run from the repository root; the root `test` script guards this.
Run them from the relevant package directory.

After changing the public Protocol or Server `HttpApi`, regenerate the legacy
JavaScript SDK:

```bash
cd packages/sdk/js
bun run build
```

Do not edit `src/v2/gen` directly. When the tree contains unrelated work, use
an isolated clean worktree: copy only the Protocol/schema change there, build,
then copy back only the generated diff. See [CONTRIBUTING.md](./CONTRIBUTING.md)
for the remaining development workflow and [AGENTS.md](./AGENTS.md) for
repository rules and style.

## Provenance and license

MIT License — see [LICENSE](./LICENSE). The on-disk notice is `Copyright (c) 2025 opencode`, retained verbatim from the upstream fork.

This repository is a fork of
[opencode](https://github.com/anomalyco/opencode) (MIT), pinned at `v1.18.11`
(`012c2f57`). Upstream's MIT notice is retained.

This fork is not built or maintained by the opencode team and is not affiliated
with opencode.
