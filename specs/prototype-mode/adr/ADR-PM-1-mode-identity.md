# ADR-PM-1 — prototype replaces plan as the primary governed-pipeline mode, in both registries together

**Status:** accepted (harness-lane)
**Date:** 2026-08-19
**Decision-makers:** repo owner, via the Principal Engineering Orchestrator session (standing authorization, 2026-08-19)
**Slice:** reference issue #88 (PM-2 implements); #89 (PM-3) removes the remnants

## Context and Problem Statement

The `plan` agent exists in two registries that have already drifted: V1 a full
record at `packages/ranex/src/agent/agent.ts:164-249` (plan-file allowlists, a
long gh/git allow-and-deny bash list, `plan_exit` allowed), V2 a thinner twin
at `packages/core/src/plugin/agent.ts:203-224` with other plan-file paths and
permission shape — same name, two behaviors, no test holding them together.

Plan mode is also the wrong product. Its artifact is a plan file nobody verifies,
its read-only promise is name-based permission config already labeled best-effort
(`agent.ts:167`), and its enter/exit pair is vestigial: `plan_exit` is a
CLI-experimental V1 tool (`packages/ranex/src/tool/plan.ts`), `plan_enter` is a
permission action with no implementing tool. The governed pipeline needs one
primary mode whose job is evidence-gated prototypes.

## Decision Drivers

- One mode name in both registries, changed together — drift ends now, not after PM-6.
- Agent switching stays the generic Tab / `/agents` mechanism; no bespoke enter/exit.
- Persisted sessions carry `agent: "plan"`; `Agent.get` (`agent.ts:380-382`) is a bare map lookup — undefined today for missing names, so degradation must be built.
- The mode occupies the primary slot `plan` occupied; no second primary appears.
- Agents are data, not protocol: no SDK regeneration, no `packages/sdk/js/src/v2/gen` change.

## Prior art

- **MADR 4.0.0** — status frontmatter and the decision-record discipline this
  package borrows: <https://github.com/adr/madr/blob/4.0.0/template/adr-template.md>
- **Nygard 2011** — decisions are recorded, superseded, never silently edited;
  D1 supersedes plan rather than mutating it in place:
  <https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions>
- **opencode's agent-as-data model** — agents are config records a plugin
  mutates at load, which is exactly the seam D1 changes (this harness is that
  fork): <https://github.com/sst/opencode>
- Kernel ADR-013 (prototype before production) — the mode exists to produce
  prototypes with evidence, not plans without: `docs/adr/ADR-013-prototype-before-production.md`
  in the kernel repo, read-only upstream reference.
- Kernel ADR-017 (approved specification before implementation authority) — a
  prototype is deliberately non-promotable; the mode's name should say what it
  is: `docs/adr/ADR-017-approved-specification-before-implementation-authority.md`.

Weakness named: opencode's model has no dual-registry atomicity story — two
sources of agent data can disagree, which is the defect being fixed here.

## Considered Options

1. **Keep `plan`, add `prototype` alongside.** Rejected: two near-identical primary modes; drift compounds instead of ending.
2. **Rename V1 now, migrate V2 later.** Rejected: registry drift is the existing defect; sequencing preserves it.
3. **Replace `plan` with `prototype` in both registries in one change; drop enter/exit.** Chosen.
4. **Keep a `prototype_enter`/`prototype_exit` pair.** Rejected: `plan_exit` was CLI-experimental, `plan_enter` is dead code; switching is already generic.

## Decision Outcome

In the context of a two-registry harness whose planning mode has drifted and whose pipeline needs a different product, facing PM-2..PM-6 all needing one mode identity, we chose to replace `plan` with `prototype` (primary) in both registries atomically — V1 `agent.ts` and V2 `plugin/agent.ts` in the same change — to make "the prototype mode" a single referent for prompt, permissions, and tests, accepting a migration for persisted `agent: "plan"` sessions and the removal of the plan-file allowlists.

Persisted-name degradation becomes a built contract, not an accident: missing
names resolve to the default agent, and historical names render as data.

### Consequences

- Good: one name, one behavior, one test surface; PM-2..PM-6 cite `prototype` unambiguously.
- Good: plan-file external-directory allowlists disappear with the record — a write-surface reduction.
- Good: no mode-specific enter/exit tools to maintain, test, or remove beyond PM-3's cleanup.
- Bad: sessions persisted with `agent: "plan"` reference a missing key until the fallback ships in PM-2 — the explicit sad-path test is mandatory, not optional.
- Bad: V2's `.ranex/plans` paths and V1's `Global.Path.data/plans` allows vanish; any user workflow writing plan files falls back to generic permissions (ask), which is correct but noisier.
- Neutral: `plan_exit` removal lands with PM-3, not here — this ADR decides identity, PM-3 removes remnants.

### Confirmation

PM-2 (#88) fails its tests unless: both registries expose `prototype` with
mode `primary`; neither exposes `plan`; and `Agent.get` on a missing name
returns the default agent rather than undefined. The existing
`packages/ranex/test/agent/agent.test.ts` and
`packages/core/test/plugin-agent-plan.test.ts` are the files those assertions
extend; new filenames belong to the implementing issue.

## Improvements on the prior art

1. **Dual-registry atomicity.** opencode's model lets two agent sources disagree; D1 requires the one-change rename and a test asserting both registries agree.
2. **Missing-name degradation as a contract.** Agent-as-data prior art leaves unknown keys undefined; here the fallback is specified and tested before the rename can ship.
3. **Modes are data; switching stays generic.** The enter/exit pattern is rejected explicitly, not merely deleted — future modes inherit the decision.
4. **Supersede, don't mutate.** Following Nygard, plan is replaced and its remnants retired in a named follow-up (#89), not edited into prototype.

## Architecture surface

V1 agents record: `packages/ranex/src/agent/agent.ts` (the `plan` entry at
164-249 becomes `prototype`; `Agent.get` at 380-382 gains the fallback). V2:
`packages/core/src/plugin/agent.ts:203-224` (`AgentV2.ID.make("plan")` becomes
`prototype`). No port, no protocol, no SDK regeneration — agents are plugin
data, and the generated client is untouched.

## Scope and threat delta

Governs mode identity only; prompt and permissions are ADR-PM-2's, the kernel
bridge ADR-PM-3's. STRIDE letters moved: **none** — no trust boundary changes;
removing the plan-file allowlists strictly reduces allowed write paths. Explicit
non-goal: making the mode name load-bearing for security. An attacker who can
write agent config is out of scope — that is already repository authority.

## Quality attributes

| characteristic | scenario | measure |
|---|---|---|
| Portability | both registries queried for the mode | one test asserts identical presence in V1 and V2 |
| Robustness | session persisted with a removed agent name | degrades to default agent; named sad-path test |
| Maintainability | a future mode rename | checklist: change both registries in one commit, extend both tests |

## Reversibility

Door: two-way

Re-add a `plan` record (or rename back) in both registries; persisted
`agent: "prototype"` sessions degrade through the same fallback built for
`plan`. No data migration exists in either direction — session agent names are
display-plus-lookup data, not durable schema.

## Sad paths

| # | Failure | Required behaviour |
|---|---|---|
| 1 | session persisted with `agent: "plan"` after the rename | `Agent.get` returns the default agent, never undefined; historical name renders as data in transcripts |
| 2 | only one registry renamed | PM-2 test fails listing the lagging registry — atomicity is asserted, not assumed |
| 3 | user config still references `plan` (`default_agent`, permission keys) | config keys are data; unknown agent names degrade through the same fallback; no crash, no silent aliasing to prototype |
| 4 | old transcript replay invokes `plan_exit` | tool is removed by PM-3 (#89); replay renders an unknown-tool part; never executes |
| 5 | plan-file allowlist removed while a workflow still writes plan files | writes fall to generic ask/deny policy — visibly noisier, never silently allowed |
| 6 | `prototype` collides with a user-defined agent name | existing user-config precedence wins and the collision test in PM-2 documents which definition serves |
| 7 | both `plan` and `prototype` present after a bad merge | the "neither registry exposes plan" assertion fails; presence is a test condition, not a hope |

## Test strategy

Existing files, extended by the implementing issue:
`packages/ranex/test/agent/agent.test.ts` (V1 registry shape, `Agent.get`),
`packages/core/test/plugin-agent-plan.test.ts` (V2 plan assertions — PM-2
retargets them at `prototype`), and
`packages/ranex/test/agent/plan-mode-subagent-bypass.test.ts` (best-effort
enforcement honesty — stays truthful for prototype). Sad paths 1, 2 and 7 map
to named assertions there; new filenames and exact test names belong to the
implementing issue #88, with removal coverage in #89 — kernel ADR-019's
"belong to the slice" precedent. Levels: unit/registry only; the e2e level is
PM-6's (#92).

## Code review checklist

- Did both registries change in one commit, or did V2 lag?
- Does any test still assert `plan`'s presence (it must assert absence instead)?
- Is the missing-name fallback actually exercised, or only implemented?
- Did any plan-file path leak into the prototype record?
- Is the mode still `primary`, and is there exactly one primary mode?
- Does anything treat the agent name as a security boundary? It must not.

## More Information

Package map: `specs/prototype-mode/README.md`. Companion decisions: ADR-PM-2
(prompt and permissions), ADR-PM-4 (evidence output visibility). Kernel
references are read-only upstream citations, not imports. Supersedes the
implicit "plan mode" decision recorded in the registries themselves.
