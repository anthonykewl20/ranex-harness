# ADR-PM-4 — bash full-log visibility: stream complete output to managed storage under a hard, marked cap

**Status:** accepted (harness-lane)
**Date:** 2026-08-19
**Decision-makers:** repo owner, via the Principal Engineering Orchestrator session (standing authorization, 2026-08-19)
**Slice:** reference issue #90 (PM-4 implements)

## Context and Problem Statement

`packages/core/src/tool/bash.ts:71-77` carries a TODO block from the V2 core
port; line 77 reads: "Stream full shell output into managed storage while
retaining only a bounded in-memory preview." Today a long command's output
beyond the capture bounds is simply absent from the session — the model cites
what it saw, and nobody can check what it did not.

Prototype mode makes this a correctness defect, not a backlog item: done
claims must cite executed-command output, and the citation is only as honest
as the retention behind it. The infrastructure already exists —
`packages/core/src/tool-output-store.ts` (MAX_LINES 2000, MAX_BYTES 50 KiB,
RETENTION 7 days, `out_` refs), `sessions.toolOutput` fetch-back, and the
`CONTEXT.md` managed-output contract including lossy-success at line 204.

## Decision Drivers

- Evidence tools return real output as tool results — "the agent saw it" must be true by construction.
- The bounded model-visible preview is unchanged; token cost stays where it is.
- Full retention needs a hard byte cap (configurable, ~20 MiB default) — unbounded disk is its own outage.
- Truncation at the cap is marked explicitly — bounded and marked, never silently lost.
- Lossy-success (`CONTEXT.md:204`): a retention-write failure never turns an exit-0 command into a failed one.
- Binary output handling stays out (the bash.ts:76 TODO is a separate debt).

## Prior art

- **Docker json-file logging driver** — `max-size`/`max-file` rotation: hard
  caps on log retention with explicit rotation rather than silent loss:
  <https://docs.docker.com/config/containers/logging/json-file/>
- **systemd-journald** — size-capped persistent logging with explicit
  vacuuming; the cap is a configured fact, not an accident:
  <https://github.com/systemd/systemd>
- **Kernel ADR-005 — hermetic observation** — the reason the *evidence* copy
  must be the real captured bytes, produced while the command runs, not a
  re-render afterwards:
  <https://raw.githubusercontent.com/anthonykewl20/ranex/main/docs/adr/ADR-005-hermetic-observation.md>
- In-repo prior art: the managed-output contract in `CONTEXT.md` (bounded
  preview, `out_` refs, lossy-success) and `ToolOutputStore` — this decision
  extends existing machinery rather than adding a second store.

Weaknesses named: Docker rotation can drop the oldest entries exactly when a
post-mortem wants them; journald's caps have the same property. The truncation
marker here is the honest answer — dropped bytes are counted, not pretended away.

## Considered Options

1. **Raise the in-memory capture bound.** Rejected: imports the full log into model-facing memory; cost and token pressure return.
2. **Stream to managed storage during execution; keep the bounded preview.** Chosen.
3. **Post-hoc dump of the accumulated buffer.** Rejected: the buffer is already bounded at capture; the tail is gone before the dump runs.
4. **Change nothing; operators rerun with redirects.** Rejected: evidence that depends on human reruns is not evidence.

## Decision Outcome

In the context of a bash tool whose captured output is bounded before anyone can inspect it, facing a pipeline whose completion claims cite command output, we chose to stream full output to the managed tool-output store during execution — reusing ToolOutputStore under `Global.Path.data/tool-output`, keeping the bounded model preview unchanged, with `out_` refs and `sessions.toolOutput` fetch-back — under a hard configurable full-retention cap (~20 MiB default) that writes an explicit truncation marker, accepting that bytes beyond the cap are dropped-and-counted and that retention is best-effort per lossy-success.

### Consequences

- Good: a done claim's citation resolves to the bytes the command actually produced, for the session's retention window.
- Good: no model-context cost changes; the preview path is untouched.
- Good: the lossy-success discipline keeps command semantics stable — exit-0 stays exit-0 when storage hiccups.
- Bad: disk grows with command volume until the 7-day cleanup; the cap bounds the worst case per command, not per session.
- Bad: bytes past the cap are gone — counted in the marker, but gone.
- Neutral: the readback path (`out_` refs) already exists; no protocol change rides along.

### Confirmation

PM-4 (#90) fails its tests unless: a command exceeding the cap produces a
truncated stored artifact WITH a marker naming the dropped byte count; a
storage failure during an exit-0 command leaves the result successful with a
lossy, path-less bounded output; and the fetched-back bytes hash to what was
streamed. The existing `packages/core/test/tool-bash.test.ts` and
`packages/core/test/tool-output-store.test.ts` are the files those assertions
extend; new filenames belong to the implementing issue.

## Improvements on the prior art

1. **Marked, not rotated.** Docker and journald rotate and eventually drop; here the artifact keeps its head, loses its tail, and says so in-band — a reviewer reads the truncation marker inside the evidence itself.
2. **Success is not hostage to retention.** Unlike daemon loggers whose write failure is a service error, lossy-success (`CONTEXT.md:204`) keeps the command's exit semantics independent of the store's health.
3. **Stream-during, not dump-after.** Following ADR-005's observe-what-ran discipline, the retained bytes are captured as they are produced, never reconstructed from a bounded buffer afterwards.
4. **One store.** No second retention path is introduced; the existing `out_` refs and fetch-back gain a producer, not a competitor.

## Architecture surface

`packages/core/src/tool/bash.ts` (close the line-77 TODO by wiring streaming
into `packages/core/src/tool-output-store.ts`), plus a config schema field for
the full-retention cap. No protocol change; `out_` refs and
`sessions.toolOutput` already exist. No change to the bounded preview path.

## Scope and threat delta

Governs command-output retention only. STRIDE: Information disclosure — the
managed directory is already Location-scoped and readable by the session's
ordinary tools; full logs raise volume, not reach, and the 7-day retention
already bounds exposure. DoS: the hard cap bounds per-command disk. Non-goal:
redacting secrets from captured output — that is a separate concern with its
own owner.

## Quality attributes

| characteristic | scenario | measure |
|---|---|---|
| Capacity | command emits past the cap | stored artifact stops at the cap with a marker naming dropped bytes |
| Integrity | reviewer fetches the out_ ref | bytes hash-match what was streamed |
| Availability | storage write fails mid-command | command result unchanged (lossy-success); operator diagnostic logged |
| Recoverability | retention expires before fetch | typed Expired result, distinct from absent |

## Reversibility

Door: two-way

Unwire the streaming call from bash.ts and drop the config field; the store,
refs, and fetch-back predate this decision and keep serving other tools. The
line-77 TODO returns, honestly, rather than a half-wired path pretending.

## Sad paths

| # | Failure | Required behaviour |
|---|---|---|
| 1 | command emits more than the cap | store truncates at the cap and writes a marker with the dropped byte count; never silent |
| 2 | storage write fails mid-command | command continues; result records the bounded output without a path; diagnostic for the operator (CONTEXT.md:204) |
| 3 | exit-0 command with retention failure | success preserved — lossy-success is the contract, not a fallback |
| 4 | fetch-back after retention expiry | typed Expired result from the existing read path; distinct from never-written |
| 5 | command times out mid-stream | partial output retained and marked with the timeout status; never presented as complete |
| 6 | binary bytes hit the text decoder | existing bash.ts:76 TODO remains open; degraded capture is marked by the decoder, not hidden |
| 7 | disk full during stream | behaves as 2: bounded lossy result, success semantics intact, operator diagnostic |
| 8 | two commands stream concurrently | store already keys per tool call (`out_` refs are per-settlement); no interleaving |

## Test strategy

Existing files, extended by the implementing issue:
`packages/core/test/tool-bash.test.ts` (stream wiring, timeout mid-stream,
lossy-success) and `packages/core/test/tool-output-store.test.ts` (cap
truncation marker, hash-match readback, expiry). Sad paths 1-3 and 5 map to
assertions there; new filenames and exact test names belong to the
implementing issue #90 — kernel ADR-019's "belong to the slice" precedent.
Levels: unit with a temp data dir; no e2e needed beyond PM-6's assembly.

## Code review checklist

- Is the truncation marker in-band (inside the stored artifact), not only in a log?
- Does any code path fail a command because retention failed?
- Is the cap configurable and defaulted, with the default named in config docs?
- Did the bounded model preview path change at all? It must not.
- Is the dropped-byte count computed from bytes, not lines, matching the cap's unit?
- Does anything re-render output after the fact instead of storing streamed bytes?

## More Information

Package map: `specs/prototype-mode/README.md`. The managed-output contract is
`CONTEXT.md`'s; this ADR closes the bash TODO listed at
`packages/core/src/tool/bash.ts:71-77`. ADR-PM-2's evidence-gated completion is
the consumer of this visibility.
