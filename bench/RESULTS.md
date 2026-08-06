# §17.4 baseline — trimmed fork vs bulky upstream

Measured 2026-08-06 on the delegated-task path. Fork at `ranex-trim`
(`4518ad3d4c`); bulky upstream at pin `012c2f57f9` (v1.18.11), checked out via
`git worktree add` + `bun install`. Model `openrouter/cohere/north-mini-code:free`,
n=3 per engine, fresh git repo + fresh scratch HOME per run (matches the real
delegation's scratch-home reality). Reproduce with `head-to-head.sh` and
`startup.sh` (both read `FORK_DIR`/`UPSTREAM_DIR`/`KEY_FILE`/`MODEL`/`RUNS`).

## Horsepower — governed tasks completed

| engine   | tasks completed |
|----------|-----------------|
| fork     | 3 / 3           |
| upstream | 3 / 3           |

Equal. Both produced the delegated `AGENT_NOTE.txt` every run (rc=0).

## Fuel economy

### Total delegated wall-time (model call included)

| run | fork (ms) | upstream (ms) |
|-----|-----------|---------------|
| 1   | 15438     | 17864         |
| 2   | 19823     | 16323         |
| 3   | 27761     | 22762         |
| **median** | **19823** | **17864** |
| mean | 21007    | 18983         |

**Model-dominated.** The provider round-trip (~10–15 s) swamps engine startup,
so total wall-time cannot isolate the trim. The fork is marginally *slower* here
(within run-to-run noise) because it carries governance overhead the upstream
lacks: the bridge commits and emits at session idle.

### Per-task startup (`serve` until "listening", no model call, no model spend)

| run | fork (ms) | upstream (ms) |
|-----|-----------|---------------|
| 1   | 2376      | 2473          |
| 2   | 2367      | 2469          |
| 3   | 2469      | 2477          |
| **median** | **2376** | **2473** |

The fork starts **~97 ms (~4%) faster, consistent across all three runs** — the
trim loads fewer modules. This is the clean engine delta once model latency is
removed.

### Tokens / cost

Identical by construction: same model, same prompt. Token and spend cost are
model-determined, not harness-determined, so the trim cannot change them.

### Provider throttling

No stalls in the six delegated runs (all rc=0). Free-tier stalls, when they
occur, are recorded as refusals by the kernel's timeout path, never silent waits.

## Honest reading

For **headless delegation** the trim does **not** buy a wall-time win: the model
call dominates, and the fork's bridge governance (~1–2 s commit+emit) offsets its
~4% startup gain, leaving total wall-time roughly equal to bulky upstream.
Horsepower is equal. The trim's value on this path is **not speed** — it is the
locked plugin surface and the smaller auditable module set (MAP §17.4 "hook
overhead" / "context bloat" rows), which is governance and maintainability,
consistent with Ranex's thesis that it optimizes the *scoring*, never the aim.

This baseline therefore does **not** show the fork beating upstream on fuel for
headless runs; it shows parity on horsepower, a small consistent startup gain, and
a small governance overhead. Any claim that the trimmed engine is faster end-to-end
on delegated tasks would overstate this evidence.
