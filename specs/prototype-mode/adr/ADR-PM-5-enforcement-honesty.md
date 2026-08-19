# ADR-PM-5 — enforcement honesty: v1 compiled constraints are tool refusals only; phases are prompt-level

**Status:** accepted (harness-lane)
**Date:** 2026-08-19
**Decision-makers:** repo owner, via the Principal Engineering Orchestrator session (standing authorization, 2026-08-19)
**Slice:** reference issue #91 (PM-5 ships the refusals); #92 (PM-6) asserts the compiled set e2e

## Context and Problem Statement

Prototype mode has two kinds of rules. Prompt rules — do research before
implementation, label findings, seek review — are suggestions a model may skip.
Tool semantics — refusals compiled into `kernel_run` and `kernel_verdict` —
actually bind. The failure mode to prevent is blurring them: an ADR that says
"the agent cannot claim done without evidence" sounds enforced when, in v1,
only the verdict channel's absence-blocks rendering is compiled.

The kernel repo models the discipline: its README once declared test counts
the collection did not produce (ADR-013's authenticity findings), and its
ADRs state works-today versus designed as separate claims. The harness already
carries the same habit at `agent.ts:167` — "Best-effort permission enforcement,
not a sandbox" — and this ADR extends it to prototype mode.

## Decision Drivers

- Every enforcement claim must be checkable as a refusal test, or it is a suggestion and must be called one.
- The v1 compiled set is small enough to enumerate exhaustively.
- PM-6's e2e can only assert what is actually compiled; a phantom gate fails there, expensively.
- Reviewers must be able to answer "is X enforced?" from one document, not from prose archaeology.
- Compiled phase gates are future work — recorded, not implied.

## Prior art

- **Saltzer & Schroeder 1975** — separation of privilege: no component should
  be able to approve its own work; the reason verdict production stays
  human-side and outside the agent's toolset:
  <https://web.mit.edu/Saltzer/www/publications/protection/>
- **Kernel ADR-013 — prototype before production** — the works-today-vs-designed
  honesty discipline this ADR mirrors, born from declared-count mismatches:
  <https://raw.githubusercontent.com/anthonykewl20/ranex/main/docs/adr/ADR-013-prototype-before-production.md>
- **Kernel ADR-017 — approved spec before authority** — authority follows an
  approved machine-readable spec, which the compiled set effectively is for
  enforcement claims:
  <https://raw.githubusercontent.com/anthonykewl20/ranex/main/docs/adr/ADR-017-approved-specification-before-implementation-authority.md>
- In-repo prior art: the best-effort label at `agent.ts:167`, unchanged by
  PM-2 — the sentence-level form of this ADR's argument.

Weakness named: Saltzer-Schroeder assumes the privilege separation is real;
under one uid (RISK-06) ours is procedural, so honesty about that gap is part
of the compiled claim set, not a footnote.

## Considered Options

1. **Ship compiled phase gates in v1.** Rejected: scope and schedule; the phase machine deserves its own ADR after the pipeline exists.
2. **Enumerate the compiled set; label everything else a suggestion.** Chosen.
3. **Describe the deny list and prompt rules as "enforcement" generally.** Rejected: that is the oversell this ADR exists to prevent — and consensus-terra's deny-bypass finding demanded the plain labeling.

## Decision Outcome

In the context of a mode whose rules live in two media with different binding power, facing reviewers who must know which is which, we chose to define v1's compiled constraints as exactly six tool refusals — no-kernel refusal, catalog-claim binding, subject-digest match, kernel-path location refusal, read-only verdict channel, absence-blocks rendering — and to state plainly that pipeline phases are prompt-level suggestions, accepting that a model can skip any phase and that only the enumerated refusals bind, with compiled phase gates recorded as future work.

### Consequences

- Good: "is X enforced?" has a one-document answer: the six-item list.
- Good: PM-6's e2e asserts the enumerable set instead of chasing prose.
- Good: the deny-bypass reality (name-based rules are policy) is stated in the same place as the rules.
- Bad: phases genuinely can be skipped in v1 — the pipeline is aspirational until a phase gate ADR exists.
- Bad: adding a seventh refusal later requires superseding this ADR, which is the point but is also friction.

### Confirmation

Each enumerated refusal maps to a failing-when-violated test in #91 (unit,
fake-kernel fixture from #92), and #92's e2e asserts the compiled set as a
list — a refusal added in code but missing from this ADR fails review against
this document. No existing harness test file asserts the set; the assertion
surface belongs to the implementing issues.

## Improvements on the prior art

1. **An enumerable compiled set.** Honesty disciplines usually say what is not proven; this ADR also fixes the positive list, so the claim is testable both ways.
2. **Suggestion/constraint vocabulary fixed once.** ADR-PM-2's prompt uses the same two words, so the model, the ADRs, and the reviewers share a vocabulary with exactly two values.
3. **Oversell prevention as a reviewable artifact.** The consensus deny-bypass finding becomes a standing checklist item, not a one-time fix.

## Architecture surface

No code of its own. Govers the semantics PM-5 (#91) compiles into
`packages/ranex/src/tool/kernel.ts` and the assertion shape #92 (#92) pins in
e2e. The prompt-side counterpart lives in the agent records (ADR-PM-2).

## Scope and threat delta

Governs claims about enforcement, not enforcement itself. STRIDE: none moved
directly; the risk addressed is epistemic — oversold enforcement invites
reliance a bypass then betrays. An attacker reading this ADR learns exactly
what binds; that is accepted, because obscurity is not among the controls.

## Quality attributes

| characteristic | scenario | measure |
|---|---|---|
| Honesty | a reader asks what v1 enforces | the six-item list answers; each item names its test |
| Traceability | a new refusal lands in code | e2e set comparison fails until this ADR is superseded |
| Clarity | prompt rule believed compiled | vocabulary says suggestion; this table says where constraints live |

## Reversibility

Door: two-way

A future phase-gate ADR supersedes the "phases are prompt-level" clause by
naming what becomes compiled; the six-refusal list then shrinks or grows by
enumeration, never by implication. Until then, deleting a refusal requires
deleting its test — the coupling is the enforcement.

## Sad paths

| # | Failure | Required behaviour |
|---|---|---|
| 1 | a prompt rule is cited as if compiled | reviewer redirects to this ADR's list; the vocabulary (suggestion) settles it |
| 2 | a seventh refusal ships without updating this ADR | #92's compiled-set assertion fails — the document and the code cannot drift silently |
| 3 | a name-based deny is bypassed via shell indirection | disclosed here and in ADR-PM-2: policy, not boundary; the real walls are enumerated (journal/merge/approval stay kernel/human-side) |
| 4 | a model skips the research phase entirely | no v1 compiled gate exists; the completion evidence gate is the binding backstop — recorded, not hidden |
| 5 | verdict absence renders as pass in some UI path | absence-blocks rendering is item six of the compiled list; its test fails the regression |
| 6 | this ADR is read as claiming no enforcement exists | the six-item list is the counter; the ADR claims exactness, not absence |

## Test strategy

No existing harness test file asserts the compiled set — by design, since the
refusals ship with #91 and the set assertion with #92; both belong to their
implementing issues (kernel ADR-019's "belong to the slice" precedent). The
refusal behaviors themselves extend the patterns in
`packages/core/test/permission-bash.test.ts` (deny-list semantics) and the
kernel-fixture tests named by #91. Levels: unit per refusal, e2e for the set.

## Code review checklist

- Does any new prose claim enforcement? Check it against the six-item list.
- Is every "cannot" in the package backed by a refusal test or rewritten as "should"?
- Does a new refusal come with an ADR supersession, or at least an amendment plan?
- Are the real walls (journal, merge, approval authority) still kernel/human-side in the code as reviewed?
- Would a reader of this ADR alone correctly predict the e2e results?

## More Information

Package map: `specs/prototype-mode/README.md`. Companion: ADR-PM-2 (the
suggestion side), ADR-PM-3 (the refusal semantics). The consensus-terra
deny-bypass finding is in the README's Consensus section. Kernel honesty
precedent: ADR-013 in the kernel repo, read-only upstream reference.
