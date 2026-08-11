# What users actually complain about in agent-CLI transcripts

Searched 2026-08-11 with `gh search issues`, scoped to the transcript surface —
message rendering, tool output, reasoning, streaming, scroll, composer, copy,
and accessibility. Every line below is a real issue someone filed. This is the
companion to `ux-research.md`, which surveyed the *board*; this one surveys the
*chat*, because ADR-022 makes the chat the main view.

| Repository | Role in this survey |
|---|---|
| `anthropics/claude-code` | the design target — and its own filed defects |
| `anomalyco/opencode` | upstream of this fork; what we inherit |
| `google-gemini/gemini-cli`, `charmbracelet/crush`, `Kilo-Org/kilocode` | field comparison |

`PROVISIONAL` — informs the transcript design; nothing here is adopted by itself.

**The point of surveying the target's own bug tracker.** The instruction was
"look like Claude Code, with improvements." You cannot state the improvement
without knowing where the original is reported to fail. Sixty-odd issues below
are Claude Code's, filed against the exact surface being copied. `cliui`'s entry
in `design-references.md` states the rule this follows: copy the mechanism, and
the "do not copy" line is the load-bearing half.

---

## 1. Tool output density is the single largest complaint class

**claude-code #57060** — *"Tool output is fully expanded by default and the
collapse toggle (▸) is non-functional"*. **#56423** — *"Tool outputs expanded by
default — no setting to collapse, inconsistent across machines"*. **#39913** —
*"Feature request: compact/tiny display mode (`--tiny` flag)"*.

Upstream has the same hole from the other side: **opencode #14511** asks for a
*"keyboard shortcut to toggle tool output"*, **#14640** for a *"minimal/quiet
output mode"*, **#15488** for an *"option to hide tool call display"*.

**Adopted.** A tool call renders as **one line by default** — verb, subject,
outcome — and expands on a keypress. The collapsed line must carry the outcome,
not just the name, or collapsing hides the thing the reader needed. Density is
persisted, per the "inconsistent across machines" complaint in #56423.

## 2. Reasoning is displayed badly by everyone, including the target

**opencode #36037** — *"Reasoning/thinking content renders one token per line in
TUI during streaming"*. **#36145** — *"Reasoning summaries expose HTML comment
placeholders"*. **#32800** — reasoning *"leaks into main response instead of
being rendered as thinking block"*. **#40671** asks for a *"Zen mode to hide
thinking blocks completely"*. **claude-code #78593** — *"No option to
hide/disable the extended thinking display… visible while streaming, hidden
after restart"*.

Ranex today renders opencode's form: `+ Thought: 458ms`. A duration is not a
summary; it tells the reader nothing about whether to open it.

**Adopted.** Reasoning is a **named, collapsed region that never interleaves
with the answer**, carries its first line as the label rather than its duration,
and is hideable permanently. Streaming into it must not reflow the answer below.

## 3. The left gutter poisons copy — and Ranex currently has one

**claude-code #75221** — *"Add option to strip/disable left gutter so copied
multi-line output has no leading spaces"*. **#74239** — *"Text-selection context
menu has no 'Copy selection' — all copy actions copy the whole message"*.
**#5512** asks for a `/copy` command. **#82886** — *"Fullscreen TUI renderer
disables mouse text selection"*. **#83236** — copying an assistant message
*"requires a two-step pointer interaction with no bindable keyboard action"*,
filed under screen-reader accessibility. **crush** closed *"Make text
selectable"*.

The screenshot of Ranex today shows exactly the construct #75221 is about: a
decorative vertical bar down the left of every message.

**Adopted, and it overrides the aesthetic.** Message identity is carried by a
**label line**, not a persistent left rule. Where indentation is unavoidable it
must be outside the selectable region. Copy is a keybinding, not a mouse
gesture, and it copies the selection when there is one.

`ux-research.md` §6 already adopted "digests must be selectable and copyable"
for the board. This is the same rule, and the transcript is where it is tested
hardest.

## 4. Scroll must own the wheel, and the composer must stay put

**claude-code #66601** — *"Scroll wheel intercepted by prompt history navigation
— no way to disable"*. **#77428** reports the same in JetBrains terminals.
**#51320** — *"Scroll regression: can't scroll conversation history at all"*.
**#65269** asks to *"Pin prompt/composer box to bottom of terminal pane"*.
**crush** — *"Add a flag to avoid continuous scroll on text generation"*.

**Adopted.** The wheel scrolls the transcript and nothing else; history recall
is a keybinding. The composer is pinned. Autoscroll **releases the moment the
reader scrolls up** and does not reclaim itself — matching the rule
`ux-research.md` §5 set for the run pane.

## 5. Streaming is where terminals actually break

**claude-code #60440** — *"high-rate terminal flicker in Windows Terminal while
Claude is actively streaming"*. **#769** — *"In-progress Call causes Screen
Flickering"*. **#55102** — *"Streaming renderer duplicates tail chunk of long
assistant reply"*. **#76838** — renderer dies mid-session with *"no SIGWINCH
redraw"*. **#17887** — *"Terminal title spinner animation causes tab width to
constantly change"*. **opencode #14560** — *"UI renders massively duplicated
content when streaming responses with code blocks"*.

**Adopted.** Frame diffing before write, per `lazygit-layout.go` and ADR-018's
existing citation; Synchronized Output evaluated as in BOARD-04. **No animation
in the terminal title** — #17887 is a whole class of defect avoided by not
animating chrome. A resize must force a full redraw, not a diff.

## 6. Syntax highlighting is where the target is weakest

**claude-code #77920** — *"Markdown code block syntax highlighting uses basic
ANSI colors instead of true color"*. **#21034** — *"renders as chaotic
rainbow/kaleidoscope colors"*. **#35288** — *"Code snippets rendered with
diff-like red/green color scheme"*. **#43664** — *"missing strikethrough and
limited color support"*. **#70496** — the theme picker *"has no effect on the
terminal TUI — only applies to code block syntax highlighting"*.

Upstream is no better: **opencode #38828** *"Markdown syntax rendered as raw
text in assistant messages"*, **#15141** *"H1-H6 headings have no visual
hierarchy, tables render poorly"*, **#8222** *"JSON code blocks strip quotation
marks"*, **#21249** nested code fences break the renderer, **#36474** markdown
table width allocation wraps narrow columns unnecessarily.

**Adopted, restrained.** A small semantic token set drawn from the *same* theme
tokens as the rest of the UI — #70496 is precisely the failure of a highlighter
with its own private palette. **Code is never coloured with the diff palette**
(#35288): `pass`/`fail` are verdict tokens in `visual-identity.md`, and spending
them on syntax would make a verdict ambiguous. Width is measured with
`string-width`, per the `cliui-table.ts` note in `design-references.md`.

## 7. Dollar signs and LaTeX: heuristics that damage output

**opencode #15892** — *"Dollar sign ($) in AI responses triggers LaTeX/math
rendering, breaking TUI output"*. **#34407** and **#39170** ask for the opposite
— real LaTeX rendering. **#38490** — *"Bold/italic closed by CJK punctuation
renders as literal asterisks"*.

**Adopted as a refusal.** No content-sniffing heuristics. A `$` is a `$`. The
inline-markup grammar is fixed and documented rather than guessed, because every
guess has a filed issue on both sides.

## 8. Diffs fail on contrast, and Ranex already gates that

**claude-code #67783** — *"Diff rendering: bold/code text invisible on red
(deleted) background lines"*. **#40825** — *"macOS light terminal mode makes some
Claude Code diff text invisible"*. **#77791** and **#85660** — custom
`diffAdded`/`diffRemoved` overrides *ignored by the diff renderer*, the latter
still open against 2.1.227. **#73951** — Write results render without
added-line highlighting *"unlike Edit"*, so the same change looks different
depending on which tool made it.

**Adopted — this is the one place Ranex is already ahead.**
`visual-identity.md` gates status-on-tint pairs at 4.5:1 as a *build* step, and
records `pass on passBg` at 4.66:1. #67783 and #40825 cannot ship here without
failing the generator. Consistency across tools (#73951) becomes a rule: a file
change renders identically regardless of which tool produced it.

## 9. Two surfaces that count the same thing will disagree

**claude-code #74355** — *"Status line displays incorrect context usage
percentage contradicting `/context`"*. **#53712** — *"status bar denominator
differs from `/context` output"*. **#33823** — mismatch between header and
`/model`. **#39297** — cache-creation tokens excluded from the denominator.
**#64546** — stale message count from the previous session.

**Adopted.** One projection feeds every place a number appears. This is
ADR-018's own recorded bad consequence — *"two surfaces render verdicts… and
they can disagree"* — arriving in the transcript, and the answer is the same:
one read, rendered many times, never two reads compared.

## 10. Queued input is lost, and its loss is silent

**claude-code #81723** — *"Add visual distinction for queued messages in CLI
output"*. **#77010** — *"queued messages and unsent input drafts are silently
lost on session switch"*. **#77451** — same on switching away and back.
**#73661** — asks that queued messages be processed *"sequentially (one message
= one turn, FIFO) instead of merging into a single combined message"*.
Upstream: **opencode #41705** *"unsubmitted prompt text drifts to adjacent tab
on terminal refocus"*, **#41732** *"`prompt_stash` keybind is displayed but not
dispatched"*.

**Adopted.** Queued input is visible as its own state and survives navigation.
A keybind that is displayed must dispatch — #41732 is the cheapest possible
lesson in not advertising what you do not do.

## 11. Permission prompts cover the thing they are asking about

**claude-code #67509** — *"AskUserQuestion dialog covers the assistant message
it refers to, with no way to read the text underneath"*. **#83879** —
*"Ambiguous click semantics in permission-prompt UI causes accidental wrong
selections"*. **#65841** — prompts *"intermittently never render"*, leaving an
indefinite spinner. **opencode #26200** — TUI crashes with `setRawMode failed`
when a permission prompt fires mid-stream.

**Adopted.** A permission request **docks and reflows**; it never overlays the
message it concerns. This is `ux-research.md` §1's sidebar rule applied to
modals, and #67509 is the proof the rule generalises. No destructive default,
and no selection on a single ambiguous click.

## 12. Accessibility is filed against the target, repeatedly and openly

**claude-code #70000** — *"Screen reader: no announcement when response is
generating or complete (NVDA)"*. **#83625** — *"`code` is the only block-level
token given neither a container nor a screen-reader form"*. **#74694** —
background-task progress has *"no screen-reader-readable text equivalent"*.
**#72702** — screen-reader mode *"forces Enter to confirm every choice"*.
**#77648** — the docs still claim permission-mode changes are not announced.

**Adopted as a rule, not a feature** — the same rule `ux-research.md` §10 set
and `theme/glyphs.ts` already implements: no state is carried by colour or a
glyph alone. Every state is spelled. Generating/complete is a spelled state, not
only a spinner.

## 13. Tool identity: names, not emoji

**opencode #27734** — *"I DONT WANT EMOJIS AS TOOL NAMES!!!! Add this as a
setting"*. **#16287** — *"Show agent type and session ID in Task tool call
display"*.

**Adopted.** Tools are spelled. A glyph may sit beside a name and never replace
it — the identical rule as verdicts. For delegation, the child's agent identity
is shown, which is also what `ux-research.md` §2 concluded for the sidebar.

## 14. The composer is a text editor, and it degrades like one

**opencode #40225** — *"v2 prompt composer: typing slows down proportionally to
the number of lines in the draft"*. **#40312** — *"Convert large pasted text into
a virtual file attachment"*. **#34410** and **#41437** ask for `@` and `/`
invocation in the composer; **#34387** for `@`-tagged files and folders;
**#32453** for fuzzy search over skill *descriptions*, not just names.
**#28843** — per-message revert *"does not dequeue a queued message; it stays in
queue and is also copied to the prompt input"*.

**Adopted.** Composer cost is bounded by the visible window, not the draft
length (#40225 is an O(n)-per-keystroke defect, and a governance session's
drafts are long). A large paste becomes an attachment rather than 400 lines of
scrollback. `@` and `/` are completion sources over one index, so adding a
source does not add a menu.

---

## Deliberately not copied

- **Expanded-by-default tool output** (claude-code #57060, #56423) — the most
  filed complaint against the target surface.
- **A left gutter on messages** (claude-code #75221) — it corrupts copied text,
  and copy is the thing operators do most.
- **Content-sniffing renderers** (opencode #15892) — LaTeX-from-`$` has filed
  issues in both directions; no heuristic satisfies both.
- **A highlighter with its own palette** (claude-code #70496) — a theme that
  does not reach the whole surface is not a theme.
- **Diff colours for code** (claude-code #35288) — `pass`/`fail` are verdict
  tokens here and cannot also mean "string literal".
- **Animated terminal chrome** (claude-code #17887) — spinner-in-title changes
  tab width forever.
- **Modal overlays over the subject** (claude-code #67509) — dock and reflow.
- **Localisation** (claude-code #73076, #68177, #53083, #66743) — repeatedly
  requested against the target, deliberately out of scope here; recorded so the
  omission is a decision rather than an oversight.

## What none of them have

Every transcript surveyed renders **what the agent did**. None renders whether
the work was **admissible** — under which grant it ran, against which subject
digest, and whether its result was accepted. That is what the board is for, and
it is why the transcript demotes the board to an opened extension rather than
deleting it: the two surfaces answer different questions, and merging them would
produce a screen that answers neither.
