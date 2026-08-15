# TUI redesign — design reference library

Prior art for the Ranex harness UI/UX redesign, fetched and vendored under
`references/`. This document is the index an agent reads before designing
anything.

## Why this exists

A specification says what someone intended; a working implementation says what
survived contact with reality. Every entry below was **fetched at a pinned
commit and read**, not recalled. `references/NOTICE.md` carries the origin,
licence and `git hash-object` of each copy.

## Rules for using it

1. **Read the vendored file before citing it.** The copy is on disk precisely so
   that "we looked at X" is checkable.
2. **Copy the mechanism, not the vibe.** Each entry below names what to take and
   what to leave. The "do not copy" line is the load-bearing half — adopting a
   design without its caveats is how you ship decoration.
3. **Nothing here is a licence to widen scope.** These inform the redesign; they
   do not authorise new surface.
4. **No copyleft.** MIT and Apache-2.0 only. See `NOTICE.md`.

## Index

| Reference | The problem it answers | Licence |
|---|---|---|
| `cliui-table.ts`, `cliui-icons.ts`, `cliui-instructions.ts` | Non-interactive CLI output vocabulary — tables, glyphs, boxed callouts | MIT |
| `textual-design.py` | Generating a whole palette from a few semantic colours | MIT |
| `lipgloss-color.go` | Colour that survives an unknown or non-colour terminal | MIT |
| `trivy-report-table.go` | Rendering a pass/fail verdict trustworthily in and out of a TTY | Apache-2.0 |
| `k9s-view-table.go` | A board of rows with keybound actions and drill-down | Apache-2.0 |
| `lazygit-layout.go` | Multi-panel layout, focus, and popups over it | MIT |
| `opentui-renderable.ts` | The rendering contract the harness already builds on | MIT |
| `kilocode-prompt.tsx`, `kilocode-theme.json` | Left-rail composer mechanics and the default dark-theme vocabulary | MIT |

---

## 1. `poppinss/cliui` — output component vocabulary

**Files:** `cliui-table.ts`, `cliui-icons.ts`, `cliui-instructions.ts`
**Pinned:** `v6.8.1` = `319531c0be1946072e7da29ea45f4514939aff06`

### What is actually in it

`icons.ts` picks one of two glyph sets *at import time*, keyed on
`platform === 'win32' && !process.env.WT_SESSION`:

| meaning | Unicode | ASCII fallback |
|---|---|---|
| tick | `✔` | `√` |
| cross | `✖` | `×` |
| bullet | `●` | `*` |
| pointer | `❯` | `>` |
| info | `ℹ` | `i` |
| warning | `⚠` | `‼` |
| vertical border | `│` | `\|` |

`table.ts` wraps `cli-table3`. Two details matter. First, `render()` has a
**`raw` branch** that emits pipe-joined cell values with no borders, no padding
and no colour. Second, the fluid-column algorithm: measure the widest cell per
column with `string-width` (not `.length`), sum them, then hand all remaining
terminal width to one nominated `fluidColumnIndex`.

### Copy

- The glyph-degradation table, as a Ranex glyph module. Gate status needs
  `PASS`/`FAIL`/`ABSENT` marks that survive a terminal without Unicode.
- `raw` mode as a **first-class output path**, not a debug flag.
- `string-width` for measurement. Cell content will contain CJK and emoji;
  `.length` will misalign every column.

### Do not copy

`cliui` is a **write-and-forget line printer**. There is no retained scene, no
re-render, no focus, no keybinding — `render()` calls `logger.log()` and the
frame is gone. It cannot back a full-screen TUI, and trying to make it one is a
dead end.

### Where it applies in Ranex

The **Python `ranex` CLI's** non-interactive output (verdicts, evidence, gate
results), not the harness TUI. The glyph set is shared by both.

---

## 2. `Textualize/textual` — palette generation

**File:** `textual-design.py`
**Pinned:** `v8.2.8` = `1d99508b928a771b51e1a527319c6b87dcff9e05`

### What is actually in it

`ColorSystem` takes roughly ten semantic colours — `primary`, `secondary`,
`warning`, `error`, `success`, `accent`, `foreground`, `background`, `surface`,
`panel`, `boost` — plus `dark: bool`, `luminosity_spread: float = 0.15` and
`text_alpha: float = 0.95`, and **generates** the rest. `shades()` yields
`{color}-darken-{1..N}` and `{color}-lighten-{1..N}` for every base colour.

`_generate_ansi()` is a wholly separate path for 16-colour terminals in which
every generated shade collapses back to its base colour.

### Copy

- **Declare ~10 semantic tokens, derive everything else.** This is the direct
  answer to the current `theme/assets/ranex.json`, which hand-codes about forty
  hex values per mode and is therefore unmaintainable and internally inconsistent.
- The separate degraded ANSI path, rather than shades that quietly look wrong at
  16 colours.
- Semantic names (`error`, `success`, `surface`) over positional ones
  (`darkStep9`). A token called `darkStep9` tells you nothing about when to use it.

### Do not copy

**Luminosity spread is not a contrast guarantee.** Shades here are produced by
lightness arithmetic; nothing in this file checks WCAG contrast between a
generated shade and the surface it lands on. Textual layers contrast handling
elsewhere. Adopt the generator without a contrast check and you will ship a
palette that is unreadable in somebody's terminal — and a governance tool whose
FAIL is hard to read has failed at its one job.

### Where it applies in Ranex

Replacing `theme/assets/ranex.json` with a generated theme, and giving the other
32 vendored themes a coherent mapping.

---

## 3. `charmbracelet/lipgloss` — colour under uncertainty

**File:** `lipgloss-color.go`
**Pinned:** `v2.0.5` = `5bd778d050f0a5a130e7cf041917927496dbe722`

### What is actually in it

- `NoColor` — an explicit *absence* of colour. Foreground falls back to the
  terminal's own default text colour and background is **not drawn at all**.
- `Color(s)` parses either a hex string or an ANSI256 index from one input.
- `LightDarkFunc func(light, dark color.Color) color.Color`, built by
  `LightDark`, resolves a colour **pair** against the detected terminal
  background.

### Copy

- **Colour as a pair, resolved once.** Every Ranex token should be
  `(light, dark)` and resolved at theme-load, not branched at each call site.
- Explicit `NoColor` instead of hardcoding black. `NO_COLOR` and piped output are
  real cases and "black" is the wrong answer in both.

### Do not copy

`LightDark` depends on the terminal **answering** a background-colour query. The
file's own doc comment concedes the workflow differs between Bubble Tea and
standalone use. Many terminals never answer, and no CI environment does. Treat
detection as reliable and you get an unreadable UI in exactly the environments
that matter for evidence. A **declared** default must win when detection is
silent.

### Where it applies in Ranex

Theme resolution, `NO_COLOR` support, and the non-TTY path shared with the
`raw` mode above.

---

## 4. `aquasecurity/trivy` — verdict rendering

**File:** `trivy-report-table.go`
**Pinned:** `v0.73.0` = `40c73e5d6166dcc0346a1ab4e94499d1572854e4`

### What is actually in it

`IsOutputToTerminal(output io.Writer) bool` decides whether styling is applied
at all: `newTableWriter(output, isTerminal)` sets `StyleBold` on the header and
`StyleDim` on the lines **only when `isTerminal`**. Borders, auto-merge and row
lines are set unconditionally.

`SeverityColor` is an ordered `[]func(a ...any) string` indexed by severity;
`ColorizeSeverity(value, severity)` resolves a name through
`dbTypes.SeverityNames` to that index. One shared buffer serves all renderers,
each result kind implements a small `Renderer` interface, and `summarize()`
produces the counts line.

### Copy

- **The content is identical whether or not it is a TTY; only styling changes.**
  This is the single most important idea in this library for Ranex. A verdict
  that reads differently in CI than on a desk is not evidence.
- Severity→colour as one ordered lookup rather than conditionals sprayed across
  renderers.
- A per-kind renderer interface over a shared buffer.

### Do not copy

Trivy's severities are a **total order** (`LOW` … `CRITICAL`), which is why an
array index works. Ranex gate outcomes are **not** totally ordered: `ABSENT` is
not a more-severe `PASS`, it is a different kind that blocks by rule. Flattening
`ABSENT` onto a severity scale would erase the invariant *absence blocks* —
the one thing the kernel exists to enforce. Model outcome as a closed sum type,
then map to colour; do not model it as a rank.

### Where it applies in Ranex

The verdict panel in the TUI and the verdict output of the `ranex` CLI.

---

## 5. `derailed/k9s` — the board

**File:** `k9s-view-table.go`
**Pinned:** `v0.51.0` = `558caafe7ba067467de46b320cc22ef11fef9c34`

### What is actually in it

Keybindings are **data**, not a switch statement. `bindKeys()` calls
`t.Actions().Bulk(ui.KeyMap{...})`; views extend the map through
`AddBindKeysFn(f BindKeysFunc)`; dispatch is
`if a, ok := t.Actions().Get(ui.AsKey(evt)); ok && !t.app.Content.IsTopDialog()`.

`SetEnterFn(EnterFunc)` supplies drill-down. Filtering runs through a buffer
(`BufferCompleted` → `t.Filter(text)`). `saveCmd` **dumps the current filtered
table to disk**.

### Copy

- Keymap-as-data with a per-view extension hook. It makes the help overlay and
  the which-key palette derivable rather than hand-maintained — the harness
  already has `which-key.tsx` and `command-palette.tsx` to feed.
- The `IsTopDialog()` guard, so a modal reliably swallows keys.
- **Dump-the-current-view-to-disk.** A governance board that can export exactly
  what the operator saw is producing evidence, not decoration. This is the
  cheapest high-value idea in the whole library.

### Do not copy

k9s reads a live cluster and re-lists on a timer. Its table is a **cache of a
remote truth**, and it will render stale rows without apology — acceptable for a
cluster browser. For Ranex a stale row is a **wrong verdict**. The board must
render durable state bound to a subject digest, and must show staleness rather
than paper over it. This is the same constraint the parked Manager UI issue
states as "the UI is never confidently wrong".

### Where it applies in Ranex

The run/gate board, its actions, and the export path.

---

## 6. `jesseduffield/lazygit` — panels and focus

**File:** `lazygit-layout.go`
**Pinned:** `v0.64.0` = `aee0e40ec1235476e9328678f0f3e2462576b9ae`

### What is actually in it

`layout(g *gocui.Gui)` recomputes `viewDimensions` every frame from the current
terminal size plus the information and status strings. `PrevLayout` caches the
last written content so `SetViewContent` only fires when something actually
changed. `popupViewNames()` and `transientContexts()` are explicit registries of
which views are modal or ephemeral. `prepareView` creates views lazily, and
focus is `Context().Activate(initialContext, types.OnFocusOpts{})`.

### Copy

- Recompute layout from terminal size each frame, but **diff before writing**.
- An explicit registry of popup/transient views instead of a boolean scattered
  across components.
- **Focus as an activated context**, not a per-panel boolean. Ranex needs this:
  approve/rerun/diff must be unambiguous about what they act on.

### Do not copy

One global `Gui` struct with views reached as `gui.Views.X`, and ~300 lines of
layout branching in a single function. In SolidJS the equivalent is fine-grained
signals and component composition; porting the struct shape would fight the
framework the harness already uses.

### Where it applies in Ranex

Arranging board / detail / transcript panes and their focus rules.

---

## 7. `sst/opentui` — the contract we build on

**File:** `opentui-renderable.ts`
**Pinned:** `v0.5.1` = `ad9a818d7a9d73f3386e92a445d0feb4b395c69e`

This is **not** a design being chosen between. `@opentui/core` and
`@opentui/solid` are already dependencies of `@ranex/tui`; this is the base
class every component in the redesign must express itself through.

`BaseRenderable extends EventEmitter` → `Renderable`, carrying `visible`,
`zIndex`, `focusable` / `focus()` / `focused`, `renderBefore` / `renderAfter`
hooks, `render(buffer, deltaTime)` with an overridable `renderSelf`, and a
`RootRenderable` at the top.

### Consequences for the redesign

- `focusable` / `focused` **is** the focus model. Do not invent a second one
  alongside it — that is how two panels end up both believing they have focus.
- `zIndex` is how modals sit above the board. The lazygit popup registry maps
  onto it.
- Rendering is `(buffer, deltaTime)` into a shared buffer. Components that want
  to "print" are misusing the framework; see the `cliui` warning above.

---

## 8. `Kilo-Org/kilocode` — composer and dark theme

**Files:** `kilocode-prompt.tsx`, `kilocode-theme.json`
**Pinned:** `64e5dd03633013b4564d0ac759747d606f74522c`

### Copy

- The left-rail composer, alpha-aware divider, warm stone surfaces, compact
  metadata row, typed extmark-backed inline placeholders, and theme semantic
  mappings.
- Adapt the accent: Ranex royal blue replaces Kilo yellow; the Ranex logo and
  `PASS`/`FAIL` semantics remain Ranex-owned.

### Do not copy

Kilo branding, Vim, cost alerts, Past chats, Memory, session sync, or
permission/autonomous semantics.

### Where it applies in Ranex

The composer and default dark theme.

---

## Deliberately not adopted

Recorded because the alternatives considered are part of the evidence.

- **`charmbracelet/bubbletea`** (MIT, `v2.0.8`) — the reference Elm-architecture
  TUI framework. Not adopted: the harness is TypeScript/SolidJS on OpenTUI.
  Adopting it means a second runtime and rewriting ~27k LOC across 190 files for
  no governance gain. Its ideas reach us through `lipgloss`, which we do cite.
- **`vadimdemedes/ink`** (MIT) — React for CLIs. Not adopted: OpenTUI already
  provides the reconciler and an optimised buffer. Ink would fork the component
  model and regress full-screen render performance.
- **`ratatui/ratatui`** (MIT) — immediate-mode Rust TUI. Not adopted: wrong
  language for this tree, and immediate-mode redraw conflicts directly with
  Solid's fine-grained reactivity.
- **`open-policy-agent/conftest`** — was the first candidate for the
  verdict-rendering citation and is a close domain match (policy pass/fail in a
  terminal). Rejected on **licence** grounds: GitHub resolves its licence as
  `NOASSERTION`. `aquasecurity/trivy` was cited instead.

## Verifying and re-fetching

Vendoring proves bytes were obtained. It does **not** prove they came from the
recorded URL — that needs a second fetch, which an offline suite cannot do.

Confirm the local copies are unmodified:

```sh
cd specs/tui-redesign/references && git hash-object *.go *.json *.py *.ts *.tsx *.txt
```

Compare against the `blob:` values in `NOTICE.md`. To re-fetch any file, the
URL is recorded there in
`https://raw.githubusercontent.com/<repo>/<40-hex>/<path>` form.

## Status

Historically `PROVISIONAL`: this library was assembled while the redesign had
no accepted ADR. Status updated 2026-08-15 — per the root README, the redesign
now runs under accepted ADR-018, "the board is the front door," on a separate
track that neither consumes the durability program nor changes kernel
authority. The pinned references and the "deliberately not adopted" record
above remain the citation base, and AGENTS.md still requires reading this file
before designing or changing anything in `packages/tui`.
