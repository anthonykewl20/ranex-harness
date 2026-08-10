# Verdict presentation contract

Two rules that any Ranex surface must obey when it shows a verdict — the TUI,
the `ranex` CLI, and anything the redesign adds. Both exist to stop rendering
from losing or distorting what the kernel decided.

They are one subject: **the screen may change how a verdict looks, never what it
says.** Rule 1 governs styling; rule 2 governs meaning.

`PROVISIONAL` — informs ADR-018, not yet adopted.

---

## Rule 1 — content is invariant under TTY detection

The bytes of a verdict must be identical whether stdout is a terminal or a pipe.
Styling — colour, bold, dim, borders, glyph choice — may differ. Content —
wording, ordering, field values, which lines appear — may not.

A verdict that reads differently in CI than on a desk is not evidence.

### Prior art

`aquasecurity/trivy`, `pkg/report/table/table.go` @ `40c73e5d6166dcc0346a1ab4e94499d1572854e4`:
`IsOutputToTerminal(output io.Writer) bool` gates styling only —
`newTableWriter` applies `StyleBold` to the header and `StyleDim` to lines when
`isTerminal`, while borders, auto-merge and row lines are set unconditionally.
The rows themselves are built the same way either way.

`poppinss/cliui`, `src/table.ts` @ `319531c0be1946072e7da29ea45f4514939aff06`:
the `raw` branch of `render()` emits pipe-joined cell values with no borders, no
padding and no colour — the same cells, undecorated.

### Current state — measured, 2026-08-10

`src/ranex` contains **no styling at all**: no `isatty`, no `NO_COLOR`, no
`colorama`, no `rich`, no ANSI literals. Verified by search across the package.

Measured directly by running the same command into a pipe and under a real pty
(`script -qec … /dev/null`), against `HEAD` of this repository:

```
gate evaluate HEAD --approver owner

sha256 (piped) 3b12542229cf67a54e2ed3ed070e9715c6e36ba4eea95799bf0fae2a72b61ace
sha256 (pty)   3b12542229cf67a54e2ed3ed070e9715c6e36ba4eea95799bf0fae2a72b61ace
```

Zero ESC bytes in either capture. The only raw difference is the `\r` the pty
line discipline appends — added by the terminal driver, not written by the
program.

**So rule 1 holds on the verdict path** — that path is genuinely undecorated.
It is an invariant to protect, not a defect to repair, and the redesign is what
puts it at risk: the harness TUI styles everything through a generated theme and
is the surface that will render verdicts next.

### The correction that matters

An earlier reading of this — *"the CLI emits no styling at all"* — measured only
the verdict path and over-generalised. Writing the test found the exception:

```
$ ranex gate evaluate --help      # under a pty
\x1b[1;34musage: \x1b[0m\x1b[1;35mranex gate evaluate\x1b[0m [\x1b[32m-h\x1b[0m] …
```

Python 3.14 gave `argparse.ArgumentParser` a `color` parameter and turned
colouring on for help and usage text when stdout is a terminal. Confirmed on
3.14.6. **Nobody in this repository chose that** — it arrived through a language
upgrade.

Help is not evidence, so this is accepted rather than fixed. But it is the whole
argument for the test: a search of `src/ranex` for `isatty` still returns
nothing, and styling is in the output anyway. A source grep cannot see what a
dependency does. Both checks are needed.

### What the redesign must do

- Compute verdict content once, in one place, with no reference to whether the
  destination is a terminal.
- Apply styling in a separate, later step that cannot add, remove, reorder or
  reword a line.
- Keep `stderr` for operational errors and `stdout` for verdicts. The CLI
  already splits them this way (`ERROR …` goes to `stderr`); preserve it.
- Honour `NO_COLOR` and a non-TTY destination by dropping styling only.

### Enforcement — built

`tests/contract/test_verdict_presentation.py` in the ranex repository. Five
tests, all passing, split by strength because the two claims are not equal:

- **Content** is identical under pipe and pty for every output shape — verdict,
  usage error, and help — compared after stripping CSI sequences. Stripping is
  only ever allowed to compare content; it never excuses a content difference.
- **A verdict** additionally carries zero `ESC` bytes on either destination.
  Narrower on purpose: help may be coloured, a verdict may not.
- **The source** contains no styling primitives (`isatty`, `colorama`, `rich`,
  raw escapes). This one cannot see argparse, which is the point of having both.

---

## Rule 2 — outcome is a closed set; cause is structured, never prose

### What the kernel actually models

`src/ranex/governed_execution/domain/verdict.py`:

```python
class Verdict(StrEnum):
    PASS = "PASS"
    FAIL = "FAIL"
```

Two values. Already a closed sum type. There is no rank, no severity scale, and
**no `ABSENT` verdict** — absence is already `FAIL`, by the invariant *absence
blocks*. The file's own header says so.

An earlier framing of this finding — "`ABSENT` must not be modelled as a
severity" — was aimed at the right risk but named the wrong thing. `ABSENT` is
not a verdict. It is one *cause* among several, and the causes are where the
information is.

### The causes, and why they must stay apart

`_diagnosis()` partitions every unsatisfied required claim into five kinds:

| Kind | What happened | Kernel wording |
|---|---|---|
| `contradicted` | two records, same claim/subject/command, disagree | "contradictory evidence — …reported both success and failure" |
| `failed` | the bound command ran against this tree and did not exit 0 | "the bound command was observed failing" |
| `failed` + suite detail | as above, with per-suite detail from `suite_diagnosis` | `<claim>: <details>` |
| `mismatched` | a record matches the subject but names a command the claim does not bind | "evidence describes a command the claim does not bind" |
| `stale` | a record names the claim but is bound to another subject digest | "evidence bound to a different subject digest" |
| `absent` | nothing at all was recorded for this claim | "no evidence for required claim" |

`cmd_gate_evaluate` in `src/ranex/cli/main.py` adds two more, from the admission
layer below the kernel:

| Kind | What happened |
|---|---|
| `refused` | a record naming this claim was rejected before the kernel saw it — a forgery or a malformed record |
| `unattributable` | a rejection carried no usable `claim_id`, so the absence sentence is withheld from the remaining claims |

Seven distinct causes. The kernel's docstring states the stakes plainly:
*"Four different events reach a caller as 'this claim is not satisfied', and only
one of them is work never done."* The CLI's comments go further — reporting a
forgery under the phrasing reserved for honest absence lets *"the attacker choose
the wording of the report by choosing which field to tamper with"*, and that is
recorded as a real defect that reopened SLICE-002.

These causes are **not ordered.** `absent` is not a worse `failed`; `refused` is
not a worse `stale`. They demand different actions from the operator — produce
the evidence, fix the code, re-run against this tree, or investigate an attack.
Any mapping that assigns them a rank and colours by that rank destroys the
distinction the kernel spent this much care to preserve.

### The gap this exposes

`Evaluation` exposes exactly two fields a renderer can use:

```python
missing_claims: tuple[str, ...]   # claim ids only — no cause
reason: str | None                # all causes, joined into one string with "; "
```

The seven causes survive only as **English prose in one string**. A UI that
wants to render them distinctly — different glyph, different colour, different
call to action — has only two options today: parse that prose, or receive a
structured field that does not yet exist.

### What the redesign must do

- **Never re-derive a cause by parsing `reason`.** Prose is for humans. A
  renderer that regex-matches "no evidence for required claim" will silently
  mislabel the day that sentence is reworded — and it will mislabel it as
  honest absence, which is the exact failure mode already fixed once.
- Model cause as a **closed sum type** in the presentation layer, mapped to
  colour and glyph by exhaustive match. No default arm, no fallthrough: a new
  kernel cause must fail to compile rather than render as something else.
- Never sort or colour causes by severity. Group by kind.
- Where the seven causes cannot be distinguished, say so rather than guess.

### The change this implies

`Evaluation` needs a structured per-claim diagnosis alongside `reason` — the
same partition `_diagnosis()` already computes, carried as data rather than
flattened into a sentence. `reason` stays for humans and for the journal record.

This is a kernel-adjacent change to a governed repository. It is **not** made
here. ADR-018 must decide it, and it must arrive with that slice.

---

## Summary of obligations

| # | Obligation | Status |
|---|---|---|
| 1 | Verdict content identical under TTY and pipe | holds today; must survive the redesign |
| 2 | Styling applied in a separate, non-content-altering step | to build |
| 3 | Byte-equality regression test under pipe vs pty | specified; lands with ADR-018 |
| 4 | Cause modelled as a closed sum type, exhaustively matched | to build |
| 5 | No rank, no severity ordering over causes | to build |
| 6 | Structured per-claim diagnosis on `Evaluation` | gap; ADR-018 to decide |
