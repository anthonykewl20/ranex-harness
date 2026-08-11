# The Ranex transcript — design

`PROVISIONAL` — informs ADR-022, not yet adopted.

The chat is the main view. This specifies what it looks like and how it behaves.
Every rule below traces to a filed issue in `chat-ux-research.md` or to a
vendored source in `design-references.md`. Nothing here is designed from memory,
which `AGENTS.md` forbids for `packages/tui`.

## The one-sentence design

**A transcript is a sequence of labelled, flush-left entries whose default form
is one line, whose every state is spelled, and whose text can be copied without
repair.**

Everything else follows from that sentence, and each clause of it is a defect
class in the surveyed field.

---

## 1. Layout

Three zones. Only the first scrolls.

```
┌ transcript ──────────────────────────────────┬ sidebar ─────┐
│                                              │ docked,      │
│   entries, flush left, newest at the bottom  │ collapsible, │
│                                              │ never over-  │
│                                              │ lays  (§1 of │
│                                              │ ux-research) │
├──────────────────────────────────────────────┴──────────────┤
│ ❯ composer — pinned, never scrolls away                     │
├─────────────────────────────────────────────────────────────┤
│ status — one row, one projection, no animation              │
└─────────────────────────────────────────────────────────────┘
```

Pinned composer: claude-code #65269. Docked sidebar: opencode #41203, already
adopted for the board. Status as a single row that never reserves a blank line:
claude-code #83402.

Layout is recomputed per frame and **diffed against the previous layout before
writing**, per `lazygit-layout.go`. A resize forces a full redraw rather than a
diff — claude-code #76838 is a missing SIGWINCH redraw.

## 2. The entry vocabulary

Six entry kinds. Each is one module; adding a kind is one file plus one line.

```
❯ you
redesign the chat interface

● ranex   build · deepseek-v4-flash                             15.4s
Ready. The session route is stock opencode — 13 lines from the fork base.

▸ thought  the front door is decided by one line in route.tsx       4.1s
▸ read     packages/tui/src/context/route.tsx                  70 lines
▸ grep     Slot name=  in packages/tui/src                    10 matches
▾ edit     packages/tui/src/context/route.tsx                    +2 −5
  31  -    props.initialRoute ?? initialRoute(startup) ?? boardRoute(),
  31  +    props.initialRoute ?? initialRoute(startup) ?? homeRoute(),

! approval required   write  packages/tui/src/context/route.tsx
  [a] approve once   [s] approve for session   [d] decline
```

**Content starts at column 0.** There is no decorative left rule and no
persistent indent on message bodies — claude-code #75221 reports that a left
gutter makes copied multi-line output unusable, and copy is the operation
operators perform most (#5512, #74239, #83236, crush *"make text selectable"*).
Identity lives on a **label line above** the content, not in a margin beside it.

The only indented region is expanded tool detail, which is verbatim payload
(diff hunks, output) where the leading columns are content — line numbers and
`+`/`-` markers — rather than decoration.

Right-aligned metadata — duration, line count, match count, diff stat — is the
**outcome**, so a collapsed entry still answers "what happened". A collapsed
line that shows only the tool name is the failure mode of claude-code #57060,
where the toggle existed and told the reader nothing.

## 3. Tool calls: one line, and the line carries the result

Default state is **collapsed**, against the target's most-filed complaint
(claude-code #57060, #56423, #39913; opencode #14511, #14640, #15488).

| column | content | rule |
|---|---|---|
| glyph | `▸` collapsed / `▾` expanded | never the only carrier of state |
| verb | `read`, `edit`, `grep`, `run`, `task` | spelled, never emoji (opencode #27734) |
| subject | path, pattern, command | truncated in the middle, never at the tail |
| outcome | `70 lines`, `+2 −5`, `10 matches`, `exit 1` | right-aligned |

A failed call spells the failure in the outcome column and is not distinguished
by colour alone. A delegated call (`task`) shows the child's agent identity —
opencode #16287, and the same conclusion `ux-research.md` §2 reached for the
sidebar.

Middle truncation, not tail truncation: a path's identifying part is its end.

## 4. Reasoning is labelled by its content, for every provider

Upstream already wants to label reasoning by content — but only succeeds for one
vendor. `context/thinking.ts:12` recovers a title by matching
`/^\*\*([^*\n]+)\*\*(\r?\n\r?\n|$)/` against the reasoning prose, and its own
comment says why: *"OpenAI's Responses API surfaces reasoning summaries that
start with a bolded title block."* Any provider that does not emit that exact
markdown yields `title: null`, and `ReasoningHeader` degrades to `Thought:
458ms` — which is precisely what the harness shows today under DeepSeek.

So the defect is not "upstream shows a duration". It is that **the label is
recovered by a regex over prose, and prose is not an interface.** ADR-018 already
banned this pattern for verdict causes — *"a renderer parses `reason` prose to
recover a cause → forbidden; the wording is not an interface"*. This is the same
defect class in the transcript.

```
▸ thought  the front door is decided by one line in route.tsx       4.1s
```

- The label comes from the reasoning part's **structure** where the provider
  supplies one, and otherwise from its first clause by a documented rule that
  does not depend on one vendor's markdown.
- Duration moves to the outcome column; it is never the only label.
- Collapsed by default, permanently hideable (opencode #40671, claude-code
  #78593), and it **never interleaves with the answer** (opencode #32800).
- Streaming into a reasoning block must not reflow the answer below it —
  opencode #36037 is that defect, rendering one token per line.

## 5. Streaming

- Text appends; nothing above the append point moves.
- Frame-diff before write; evaluate Synchronized Output (`DCS = 1 s ST`), as
  BOARD-04 already carries. Flicker: claude-code #60440, #769.
- **Nothing in the terminal title animates.** claude-code #17887 — a title
  spinner changes tab width forever.
- The live state is spelled in the status row: `responding`, `running read`,
  `waiting for approval`. A spinner may accompany it and never replace it —
  claude-code #70000, where a screen reader was told nothing about generating or
  complete.
- Append is idempotent on the same chunk id. claude-code #55102 and opencode
  #14560 are both duplicated-tail defects.

## 6. Markdown and code

A small, semantic token set drawn from the **same theme tokens as the rest of
the UI**. claude-code #70496 — a theme picker that reaches only the highlighter
— is what a private palette produces.

- **Code is never coloured with the diff palette.** claude-code #35288 renders
  snippets red/green; here `pass` and `fail` are the two values of `Verdict`
  (`visual-identity.md`) and cannot also mean "string literal".
- Headings get real hierarchy (opencode #15141); tables measure with
  `string-width`, never `.length`, per `cliui-table.ts` (opencode #36474).
- Nested fences are parsed, not regex-matched (opencode #21249, #8222).
- **No content sniffing.** A `$` is a `$` — opencode #15892 versus #34407 and
  #39170 is a heuristic with filed issues in both directions.
- Line breaks are inserted outside style spans, never inside them —
  claude-code #21933.

## 7. Diffs

The one place this design starts ahead. `visual-identity.md` gates every
status-on-tint pair at 4.5:1 **in the generator**, which writes nothing when a
floor is breached. claude-code #67783 (bold text invisible on deleted-red) and
#40825 (invisible diff text in light terminals) cannot ship through that gate.

Two further rules from the same tracker: theme overrides must reach the diff
renderer (#77791, #85660 — still open against 2.1.227), and **a file change
renders identically regardless of which tool produced it** (#73951, where Write
and Edit disagreed).

## 8. Permission requests dock, never overlay

```
! approval required   write  packages/tui/src/context/route.tsx
  [a] approve once   [s] approve for session   [d] decline
```

It is an entry in the transcript, in position, reflowing what follows —
claude-code #67509, where the dialog covered the message it was asking about.
No destructive default and no single ambiguous click (#83879). If a request
cannot be rendered, that is a spelled state, not an indefinite spinner (#65841).

## 9. Composer

- Pinned (claude-code #65269).
- **Editing cost is bounded by the visible window, not draft length** — opencode
  #40225 slows proportionally to draft lines, and governance drafts are long.
- A large paste becomes an attachment entry rather than scrollback (#40312).
- `@` and `/` are completion *sources over one index*, so adding a source does
  not add a menu (opencode #34410, #41437, #34387, #32453).
- Unsent drafts and queued input **survive navigation** and are visibly queued —
  claude-code #77010, #77451, #81723; opencode #41705, #28843.
- A displayed keybind dispatches. opencode #41732 is the cheapest lesson
  available in not advertising what you do not do.

## 10. Scroll and copy

- The wheel scrolls the transcript. History recall is a keybinding, never the
  wheel — claude-code #66601, #77428.
- Autoscroll **releases when the reader scrolls up and does not reclaim
  itself** — crush, and `ux-research.md` §5.
- Copy is a keybinding, copies the selection when one exists, and yields text
  needing no repair — claude-code #74239, #75221, #83236, #82886.

## 11. Density

Three modes, persisted across machines (claude-code #56423 reports
inconsistency as the defect):

| mode | tools | reasoning | answer |
|---|---|---|---|
| `compact` | one line, no expand | hidden | text only |
| `normal` *(default)* | one line, expandable | collapsed | full markdown |
| `full` | expanded | expanded | full markdown |

`compact` answers claude-code #39913 (`--tiny`) and opencode #14640.

## 12. Degraded rendering, and `raw` as a first-class path

Reuses `theme/glyphs.ts` (BOARD-03), which already implements `cliui-icons.ts`'s
degradation table keyed on encoding rather than platform.

- `NO_COLOR` or a pipe: styling drops, **content is byte-identical**. This is
  ADR-018's presentation contract, and the same property a screen reader needs.
- 16-colour terminals: degraded palette, same content, per `lipgloss-color.go`'s
  `NoColor` — foreground falls back to the terminal default and background is
  not drawn.
- No Unicode: ASCII glyphs. Nothing is lost, because no state was ever carried
  by a glyph.
- **`raw` mode is a supported output, not a debug flag** — the `render()` raw
  branch in `cliui-table.ts` is the model. It is what a screen reader, a log, and
  a bug report all want, and it answers claude-code #83625 (`code` blocks with no
  screen-reader form).

`cliui`'s own caveat from `design-references.md` still binds: it is a
write-and-forget line printer with no retained scene, so it informs the **output
vocabulary** and can never back the interactive path.

## 13. Keymap as data

Bindings are a table, so remapping is configuration rather than a fork —
`k9s-view-table.go`, already adopted in BOARD-10, and crush's shortcut-collision
complaint in `ux-research.md` §7. Dispatch is guarded while a modal owns input.

## 14. Module layout

The seam that lets this be built in parallel. It is the board's pane pattern
(`feature-plugins/board/pane.tsx`, commit `656fdd4815`): **one module plus one
line in a registry**, ordering from each entry's own `order` field so two
concurrently-added entries cannot silently reorder each other.

```
packages/tui/src/routes/session/index.tsx   +named slots only        CHAT-01
packages/tui/src/feature-plugins/transcript/
  index.tsx        plugin registration, binds the slots    CHAT-01
  chrome.tsx       the three-zone shell                    CHAT-01
  entry.ts         the Entry contract + TranscriptData     CHAT-02
  entries/
    index.ts       registry, order spaced by 100           CHAT-02
    user.tsx                                       100     CHAT-03
    assistant.tsx                                  200     CHAT-04
    reasoning.tsx                                  300     CHAT-05
    tool.tsx                                       400     CHAT-06
    permission.tsx                                 500     CHAT-09
    error.tsx                                      600     CHAT-09
  render/markdown.ts                                       CHAT-04
  render/code.ts                                           CHAT-07
  render/diff.ts                                           CHAT-08
  composer/                                                CHAT-10, CHAT-11
  status.tsx                                               CHAT-12
  keymap.ts                                                CHAT-17
```

`routes/session/` keeps **one owner of session lifecycle** — permissions,
questions, subagents, retries, revert — and gains only named render slots. That
is the whole of the upstream-owned edit, and it is what keeps `packages/tui`
mergeable: the directory moved +30/−13 upstream over the ten days to 2026-08-11,
so a seam measured in tens of lines is affordable and a duplicate 2710-line
owner is not.

It is also upstream's own idiom. Eight slots already exist — `home_logo`,
`home_prompt`, `home_prompt_right`, `home_bottom`, `home_footer`,
`sidebar_content`, `sidebar_footer`, `session_prompt_right` — and the session
body is simply the one place upstream never carved.

An earlier revision of this design built a **new route** instead, leaving
upstream's unreached. That was withdrawn on evidence: `component/prompt/index.tsx:1133`
and `app.tsx:999` both navigate to `{ type: "session" }`, which `app.tsx:1121`
renders with upstream's component. Sending a first message reaches it, so
"unreached" was never true.

### The slot contract, copied from source

Read at `@opentui/core@0.4.5/plugins/types.d.ts:3` — slots are a **framework
primitive**, not an opencode invention, which is what makes extending them the
conservative move rather than the inventive one:

```ts
export type SlotMode = "append" | "replace" | "single_winner"
```

The harness-side shape, `packages/plugin/src/tui.ts:496`:

```ts
export type TuiSlotProps<Name extends string = string, Slots extends Record<string, object> = {}> = {
  name: Name
  mode?: SlotMode
  children?: JSX.Element
} & TuiSlotShape<Name, Slots>
```

New slots are declared in `TuiHostSlotMap` (`tui.ts:455`) and must follow its
existing convention: **every session-scoped slot carries `session_id: string`**,
as `session_prompt`, `session_prompt_right`, `sidebar_content` and
`sidebar_footer` all do.

**Check what already exists before adding one.** The map declares twelve slots
and **all twelve are rendered**, two of them inside the session route itself:
`session_prompt` at `routes/session/index.tsx:1300` and `sidebar_title` at
`routes/session/sidebar.tsx:50`.

That corrects an earlier claim here that the session route carried a single slot
and that two declared slots were unwired. Both were wrong, and wrong the same
way: the grep behind them required `name=` on the same line as `Slot`, which
multi-line JSX defeats. The composer seam this design needs therefore **already
exists** — `session_prompt` takes `session_id`, `visible`, `disabled`,
`on_submit` and `ref` — so CHAT-10 binds a slot rather than cutting one.

## 15. What this deliberately does not do

- Render a verdict. That is the board, opened deliberately — a transcript that
  showed a verdict would be a second read of the same state, which is exactly
  how claude-code #74355 and #53712 produce two numbers that disagree.
- Localise (claude-code #73076, #68177, #53083, #66743). Out of scope, recorded
  so it is a decision.
- Introduce mouse-only affordances. Every action has a keybinding.
