# ADR-PM-3 — a subprocess-only ranex-kernel bridge: kernel_run evidence and kernel_verdict reads, never imports

**Status:** accepted (harness-lane)
**Date:** 2026-08-19
**Decision-makers:** repo owner, via the Principal Engineering Orchestrator session (standing authorization, 2026-08-19)
**Slice:** reference issue #91 (PM-5 implements); #92 (PM-6) covers e2e against the fake kernel fixture

## Context and Problem Statement

Prototype mode's evidence-gated completion needs two things from the
ranex-kernel: measured command evidence and signed verdicts. The kernel is a
short-lived Python CLI (`uv`-managed, `PYTHONPATH=src`); the harness is
TypeScript. Importing kernel code is banned for the same reason the kernel
invokes its own confinement session as a subprocess (`docs/adr/ADR-023`):
import dissolves the process boundary.

The surfaces to wrap, observed at kernel commit `55a01518e867bc5630fc099a4c37cf30f9ff72a0`: `run --claim C
--producer P -- <cmd>` (`main.py:2686-2690`; both flags required, no `--ref` —
the subject is always HEAD); the committed catalog `governance/gates.yaml`
binding claim to exact argv (SLICE-003); and ADR-019's signed verdict files
under `governance/verdicts/` (`main.py:151`).

## Decision Drivers

- Subprocess-only; never import, link, or vendor kernel code — the trust boundary stays a process boundary.
- Claims are restricted to the kernel's committed gate catalog; the kernel's claim→argv digest binding enforces this, not the harness.
- kernel_verdict is read-only; verdict PRODUCTION (`gate evaluate`) stays a human act — the agent never invokes it: no self-approval.
- Subject-digest match: a verdict about another tree is refused with both digests shown (ADR-019 sad path 8).
- Absence never renders as pass; the reader-state set is total (ADR-019).
- Kernel discovery is explicit — `kernel.path` config or `RANEX_KERNEL` env; unset refuses; the resolved path must sit outside the session worktree AND outside the harness repo.

## Prior art

- **Kernel ADR-019 — the verdict read channel** — the reader-state set this
  tool renders, and the rule that absence is its own state:
  <https://raw.githubusercontent.com/anthonykewl20/ranex/main/docs/adr/ADR-019-the-verdict-read-channel.md>
- **Kernel ADR-005 — hermetic observation** — the measured command's
  environment is built from empty by the kernel, never inherited from the
  observed party:
  <https://raw.githubusercontent.com/anthonykewl20/ranex/main/docs/adr/ADR-005-hermetic-observation.md>
- **Kernel ADR-023 — confinement session as subprocess** — the import-is-banned
  precedent D3 follows:
  <https://raw.githubusercontent.com/anthonykewl20/ranex/main/docs/adr/ADR-023-the-confinement-session-is-invoked-as-a-subprocess.md>
- **Kernel delegation seam** (`src/ranex/cli/delegation.py`) — the kernel
  already invokes the harness as `<harness> --dir <worktree> --model M --auto
  <prompt>` and refuses signing credentials in `/proc/self/environ` (34-44);
  the bridge is that seam's return path:
  <https://github.com/anthonykewl20/ranex/blob/main/src/ranex/cli/delegation.py>
- **cosign's typed exit codes** — absence parted from invalidity at the process
  boundary, the discipline kernel_verdict's state set carries into the harness:
  <https://github.com/sigstore/cosign>

Weaknesses named: cosign classifies only its own typed errors; ADR-019 itself
concedes the verdict directory is a transport, not a boundary, under one uid.

## Considered Options

1. **Import the kernel as a library.** Rejected: couples a TypeScript harness to a Python signer; ADR-023's ban exists because import dissolves the process boundary.
2. **A long-lived kernel service.** Rejected: the kernel is a short-lived CLI that exits; ADR-019 rejected the daemon for the same reader-attach reason.
3. **Subprocess wrap of `run --claim --producer`, plus read-only verdict-file reads.** Chosen.
4. **Shell out to `gate evaluate` and parse stdout.** Rejected: it hands the untrusted process the choice of when judging happens (ADR-019's option-4 rejection) — and it would be self-approval.

## Decision Outcome

In the context of a TypeScript harness that must not touch kernel internals, facing a kernel that already exposes a measured-run CLI and signed verdict files, we chose two subprocess-only tools — `kernel_run` wrapping `PYTHONPATH=src uv run --frozen python -m ranex.cli.main run --claim C --producer P -- <cmd>` with cwd at the configured kernel repo, and `kernel_verdict` performing read-only verification of `governance/verdicts/` files against the current worktree digest — to make evidence producer-side and verdicts human-side, accepting a same-uid trust disclosure (RISK-06 parity) and a config-refusal contract for kernel discovery.

kernel_run returns structured evidence — exit code, subject digest, evidence
path — plus the real command output. kernel_verdict renders the total
ADR-019 reader-state set: absent, unverified, unknown-producer, wrong-type,
subject-mismatch, freshness-unproven.

### Consequences

- Good: "the agent saw real output" is true by construction for kernel_run results, and verdicts are never computed harness-side (`packages/schema/src/verdict.ts` renders, never judges).
- Good: the kernel's own catalog binding (SLICE-003) does the claim enforcement — the harness refuses to re-implement a digest scheme it would get wrong.
- Good: no self-approval path exists; `gate evaluate` is not wrapped, and its stdout is never parsed.
- Bad: subprocess spawn per evidence command is slower than a library call — latency accepted, correctness first.
- Bad: signing keys sit in the operator env the bridge inherits; a compromised same-uid harness can read them. Disclosed as RISK-06 parity, not solved here.
- Neutral: kernel discovery is opt-in; no default path is guessed.

### Confirmation

PM-5 (#91) fails its tests unless: unset `kernel.path`/`RANEX_KERNEL` refuses;
a path inside the session worktree or harness repo refuses; a claim outside
the committed catalog is refused and surfaced; a verdict whose subject digest
differs from the worktree digest is refused showing both digests; and a
missing verdict renders absent, never pass. The e2e level runs against the
fake kernel fixture owned by #92. New filenames belong to the implementing issue.

## Improvements on the prior art

1. **Location refusal on top of ADR-019.** The kernel guards what a verdict is; the bridge additionally refuses a kernel checkout that lives inside the session worktree or the harness repo — the hostile-checkout remediation from consensus review.
2. **No re-implementation of binding.** cosign-class tools classify at their own boundary; here the claim→argv binding stays in the kernel catalog and the bridge adds no second digest scheme to drift.
3. **Explicit credential posture.** Where ADR-019 documents same-uid limits, this ADR names the inherited-key exposure in the harness lane and points at the kernel's own `/proc/self/environ` refusal as the model for any future tightening.
4. **Read channel mirrors write authority.** The delegation seam runs the harness; this seam reads the kernel back — one direction of authority per direction of data.

## Architecture surface

New: `packages/ranex/src/tool/kernel.ts` (both tools), its registry entries,
and the `kernel.path` config schema field (`RANEX_KERNEL` env alternative). The
verdict wire types already exist at `packages/schema/src/verdict.ts`. No
kernel-side file changes; no protocol change beyond tool registration.

## Scope and threat delta

STRIDE. Tampering: evidence is produced kernel-side under its hermetic env
(ADR-005); the harness cannot forge a signed verdict without the key. Spoofing:
unknown producer and wrong-type verdicts refuse. Elevation: a `kernel.path`
inside the worktree would execute attacker-controlled Python — refused by
location check; residual same-uid compromise is disclosed (RISK-06), not
claimed defended. Non-goal: protecting against the operator's own uid.

## Quality attributes

| characteristic | scenario | measure |
|---|---|---|
| Fail-closed | kernel path unset, missing, or misplaced | refuses with a named reason; never guesses a default |
| Honesty | no verdict file for this subject | renders absent — never pass, never blank |
| Determinism | same claim, same catalog entry | kernel binds argv; harness adds no degrees of freedom |
| Isolation | any bridge operation | zero kernel imports; process boundary only |

## Reversibility

Door: two-way

Delete `kernel.ts`, its registry entries, and the config field; nothing else
depends on them. Prototype mode loses evidence gating (ADR-PM-2's prompt still
demands citations) but nothing breaks at runtime — the tools refuse absent,
they do not block startup.

## Sad paths

| # | Failure | Required behaviour |
|---|---|---|
| 1 | `kernel.path` and `RANEX_KERNEL` both unset | tool refuses with a clear error naming both configuration sources |
| 2 | resolved kernel path inside the session worktree or the harness repo | refuse before any spawn — the hostile-checkout finding's compiled guard |
| 3 | claim not present in the committed gate catalog | kernel refuses (gates.yaml binding); the tool surfaces the refusal verbatim, no retry loop |
| 4 | argv differs from the catalog binding for that claim | kernel command-digest mismatch refusal (SLICE-003) is surfaced; the harness never edits argv to fit |
| 5 | verdict file's subject digest differs from the current worktree digest | refuse, showing both digests — stale-subject verdicts never read as current |
| 6 | no verdict file exists | render absent as its own state; never an empty result that could pass |
| 7 | verdict superseded by a later publication crash | freshness-unproven state (ADR-019 sad paths 2/7); no currentness claim |
| 8 | signature invalid or producer not in the keyring | unverified / unknown-producer states, kept distinct from absent |
| 9 | `uv` missing or kernel checkout broken | spawn failure is an operational refusal; surfaced with exit status, never a fake evidence record |
| 10 | model attempts `gate evaluate` via bash | name-based deny (policy); the durable wall: approver identity and keyring are kernel/human-side — the agent has no approver authority to invoke |

## Test strategy

No existing harness test file covers a kernel bridge; every filename here is
new and belongs to the implementing issue #91 (kernel ADR-019's "belong to the
slice" precedent), with the e2e level against the fake kernel fixture owned by
#92. Sad paths 1-2, 5-6 map to unit refusals over a fixture checkout; 3-4 to
catalog-binding refusals; 10 to the permission deny list already covered by
`packages/core/test/permission-bash.test.ts` patterns. Levels: unit + e2e; no
integration against a real signing key in CI.

## Code review checklist

- Does any line import, require, or vendor kernel code?
- Is every refusal in the sad-path table a compiled check, not a prompt suggestion?
- Does any code path parse `gate evaluate` output, or invoke it?
- Are both digests shown on subject mismatch?
- Is the env inheritance documented at the spawn site, with the RISK-06 disclosure?
- Does absence have a renderer distinct from invalid?

## More Information

Package map: `specs/prototype-mode/README.md`. Reader-state authority: kernel
ADR-019. Hermetic env: kernel ADR-005. The credential-exposure and
hostile-checkout findings and their remediations are in the README's Consensus
section. `packages/schema/src/verdict.ts` is the render-only wire contract.
