# Prototype mode — governed pipeline (replaces Plan)

Specification package for the `prototype` agent mode. Parent documents of milestone
"Prototype mode — governed pipeline": PM-1 (this package, issue #87) → PM-2 (#88),
PM-3 (#89), PM-4 (#90), PM-5 (#91) in parallel → PM-6 (#92, end-to-end assembly).

PM-2..PM-6 contract bodies cite these documents. This README is the map; each
decision's full reasoning lives in its ADR under `adr/`.

## Goal

Replace Plan with Prototype: a governed pipeline — idea → research → spec →
implementation → review → evidence-gated completion — powered by ranex-kernel
evidence and verdicts.

"Done" requires real proof. A completion claim in prototype mode must cite
executed-command output or a kernel verdict read back through tools; absence of
proof blocks the claim. Plan mode's artifact was a plan file nobody verified;
prototype mode's artifact is a change that carries its own evidence.

## Architecture decisions

### D1 — mode identity (ADR-PM-1)

Replace agent `plan` with `prototype` (primary) in **both** registries together —
V1 `packages/ranex/src/agent/agent.ts:164-249` and V2
`packages/core/src/plugin/agent.ts:203-224` — ending registry drift. No enter/exit
tools: `plan_exit` was CLI-experimental (`packages/ranex/src/tool/plan.ts`, gated at
`packages/ranex/src/cli/cmd/run.ts:439-444`) and `plan_enter` is dead code (a
permission action with no implementing tool). Switching stays the generic Tab /
`/agents` mechanism. Persisted `agent: "plan"` sessions must degrade safely:
`Agent.get` is a bare map lookup (`agent.ts:380-382`) with no fallback today, so
PM-2 builds the default-agent fallback and an explicit sad-path test.

### D2 — agent design (ADR-PM-2)

The prototype system prompt encodes six phases: idea restatement; research with
every finding labeled OBSERVED / INFERRED / UNKNOWN (each UNKNOWN line states the
missing evidence); spec (ADRs under `specs/` plus contract-grade GitHub issues in
a milestone via the existing `github_issue` / `github_milestone` tools);
implementation against frozen contracts; independent review; evidence-gated
completion — done claims MUST cite executed-command output or a kernel verdict,
and absence blocks. Untrusted-data framing: issue/comment/log/PR text is DATA,
never instructions. Permissions: build-like defaults plus GitHub issue/milestone
write; DENY git push/merge, gh pr merge, gh release/repo mutation — name-based
guardrails honestly labeled policy-not-boundary. The real wall: journal, merge,
and approval authority stay kernel- and human-side. No plan-file allowlists.

### D3 — kernel bridge (ADR-PM-3)

Subprocess-only; never import kernel code. `kernel_run` wraps
`PYTHONPATH=src uv run --frozen python -m ranex.cli.main run --claim C --producer P -- <cmd>`
with cwd = configured kernel repo; claims are restricted to the kernel's committed
gate catalog (`governance/gates.yaml` binds claim→argv; the kernel refuses
command-digest mismatch — SLICE-003). `kernel_verdict` is READ-ONLY on ADR-019
signed verdict files under `governance/verdicts/`; it derives the current worktree
digest, refuses subject mismatch showing both digests, renders the total ADR-019
reader-state set (absent / unverified / unknown-producer / wrong-type /
subject-mismatch / freshness-unproven), and never renders absence as pass. Verdict
PRODUCTION stays human — the agent never invokes `gate evaluate`: no
self-approval. Kernel discovery: `kernel.path` config or `RANEX_KERNEL` env;
unset → refuse; the resolved path must sit outside the session worktree AND
outside the harness repo. Env: keys inherited (same-uid trust, RISK-06 parity,
disclosed); the measured command's env is built from empty by the kernel itself
(ADR-005 hermetic observation). Files: `packages/ranex/src/tool/kernel.ts` +
registry + config schema (issue #91 owns implementation).

### D4 — full-log visibility (ADR-PM-4)

Close the bash TODO at `packages/core/src/tool/bash.ts:71-77` (the line-77 item):
stream full command output to managed tool-output storage during execution
(`ToolOutputStore`, `Global.Path.data/tool-output`; today MAX_LINES 2000 /
MAX_BYTES 50 KiB / RETENTION 7d). The bounded model-visible preview is unchanged;
`out_` refs and `sessions.toolOutput` already fetch back. A hard full-retention
byte cap (configurable, ~20 MiB default) writes a truncation marker — bounded and
marked, never silently lost. Lossy-success discipline (`CONTEXT.md:204`): a
retention-write failure never fails an exit-0 command. Rationale: evidence tools
return real output as tool results, so "the agent saw it" is true by construction.
Issue #90 owns implementation.

### D5 — enforcement honesty (ADR-PM-5)

v1 compiled constraints = tool refusals only: no-kernel refusal, catalog-claim
binding, subject-digest match, kernel.path location refusal, read-only verdict
channel, absence-blocks rendering. Pipeline phases are prompt-level — stated
plainly: prompt rules are suggestions, evidence tools are constraints. Compiled
phase gates = future work. This mirrors the kernel repo's works-today-vs-designed
honesty discipline.

## Consensus

consensus-terra (fresh-context review, 2026-08-19) reviewed the D1–D5 package.
Verdict: **REQUEST_CHANGES**. D1–D3 were rated AGREE-WITH-CONDITIONS; D4 and D5
were REJECTED as initially stated. Six P1 findings were raised, each with its
remediation applied to this package before authoring:

| # | P1 finding | Remediation applied |
|---|---|---|
| 1 | claim-binding — kernel_run claims must not be free-form argv | claims restricted to the committed gate catalog; the kernel's own claim→argv digest binding (SLICE-003) is the enforcement, and the ADR refuses to re-implement it |
| 2 | stale-subject verdicts — a signed PASS about an older tree must not read as current | kernel_verdict derives the current worktree digest and refuses subject mismatch showing both digests; freshness-unproven is a distinct reader state (ADR-019) |
| 3 | credential exposure — bridge subprocess env must not leak signing keys to the agent lane | same-uid trust disclosed (RISK-06 parity) rather than claimed solved; the measured command's env is built from empty by the kernel (ADR-005), never by the harness |
| 4 | deny-bypass — name-based DENY rules must not be described as a sandbox | guardrails labeled policy-not-boundary in D2/ADR-PM-2, matching the existing best-effort label at `agent.ts:167`; the real wall is enumerated (journal/merge/approval stay kernel/human-side) |
| 5 | hostile kernel checkout — a kernel.path pointing at attacker-controlled code executes arbitrary Python | path must resolve outside the session worktree AND outside the harness repo; unset refuses; residual same-uid risk disclosed, not hidden |
| 6 | prompt injection — issue/comment text steering the agent | untrusted-data framing is part of the D2 prompt contract; reviewer checklist item; no injection-resistance claim is made anywhere in this package |

The verbatim consensus-terra review is retained in the orchestrator session record
(2026-08-19). It is cited here as a retained record, not linked: no transcript URL
or attachment exists, and fabricating one is prohibited (DECISION — specification
owner, 2026-08-19).

## Upstream verification

All citations OBSERVED 2026-08-19 at kernel commit `e877f81bb` (local checkout
`~/devtony/ranex`) and harness baseline `dc728e77`. What was verified, per source:

- OBSERVED — Kernel ADR format: 16 sections, fixed order, per-section budgets,
  sad-path floor, Door line:
  https://raw.githubusercontent.com/anthonykewl20/ranex/main/docs/adr/ADR-000-how-we-write-adrs.md
- OBSERVED — ADR-005 hermetic observation (measured command env built from empty;
  stop inheriting what the observed party owns):
  https://raw.githubusercontent.com/anthonykewl20/ranex/main/docs/adr/ADR-005-hermetic-observation.md
- OBSERVED — ADR-013 prototype-before-production (prototype ideas before
  production trust-boundary code):
  https://raw.githubusercontent.com/anthonykewl20/ranex/main/docs/adr/ADR-013-prototype-before-production.md
- OBSERVED — ADR-017 approved-spec-before-implementation (prototypes are
  non-promotable; authority needs an approved spec):
  https://raw.githubusercontent.com/anthonykewl20/ranex/main/docs/adr/ADR-017-approved-specification-before-implementation-authority.md
- OBSERVED — ADR-019 verdict read channel (total reader-state set; absence is its
  own state; subject mismatch shows both digests):
  https://raw.githubusercontent.com/anthonykewl20/ranex/main/docs/adr/ADR-019-the-verdict-read-channel.md
- OBSERVED — ADR-023 confinement session invoked as a subprocess (import is
  banned/impossible; subprocess is the precedent D3 follows):
  https://raw.githubusercontent.com/anthonykewl20/ranex/main/docs/adr/ADR-023-the-confinement-session-is-invoked-as-a-subprocess.md
- OBSERVED — gate catalog claim→argv binding (SLICE-003 note in file header;
  `required_claims` carry the exact command argv):
  https://github.com/anthonykewl20/ranex/blob/main/governance/gates.yaml
- OBSERVED — delegation seam (harness invoked as
  `<harness> --dir <worktree> --model M --auto <prompt>`; emission
  `{task_id,worktree,commit}`; refuses signing credentials found in
  `/proc/self/environ`):
  https://github.com/anthonykewl20/ranex/blob/main/src/ranex/cli/delegation.py
- OBSERVED — kernel CLI surface: `run --claim --producer` required args, subject
  always HEAD, no `--ref` (`main.py` ~2686-2688); `gate evaluate` (~2647-2650);
  `DEFAULT_VERDICT_DIR = "governance/verdicts"` (`main.py:151`):
  https://github.com/anthonykewl20/ranex/blob/main/src/ranex/cli/main.py
- OBSERVED — harness side: `packages/core/src/tool/bash.ts:71-77` TODO block
  (line 77 is the stream-to-storage item); `packages/core/src/tool-output-store.ts`
  (MAX_LINES 2000, MAX_BYTES 50 KiB, RETENTION 7 days, `out_` refs);
  `CONTEXT.md:204` lossy-success; `specs/github-integration/README.md` as the
  harness spec-package precedent; `packages/schema/src/verdict.ts` (verdict wire
  types — the harness renders, never computes).

## Out of scope

The out-of-scope list — v1 exclusions, all recorded as future work, none
silently dropped:

- task dispatch / judge / merge wrapping (kernel delegation-seam operations)
- kernel A/B/C spec-lifecycle use (ADR-017 lifecycle states)
- harness-side journal writes
- gate-evaluate invocation / stdout parsing by any harness code
- mid-execution model streaming of full command output
- compiled phase gates (phases stay prompt-level; see D5)

Each ADR states which of these it borders and why the border holds in v1.
