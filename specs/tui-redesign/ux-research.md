# What users actually complain about in agent CLIs

Searched 2026-08-10 with `gh search issues` across the agent-CLI field. Every
line below is a real issue someone filed, not an impression. Counts are the
repositories' own at time of search.

| Repository | Stars | Open issues |
|---|---|---|
| `google-gemini/gemini-cli` | 106,438 | 854 |
| `block/goose` | 52,626 | 293 |
| `Aider-AI/aider` | 48,093 | 1,784 |
| `charmbracelet/crush` | 27,247 | 625 |
| `Kilo-Org/kilocode` | 26,807 | 662 |
| `anomalyco/opencode` | — | upstream of this fork |

`block/goose` issue search returns `Invalid search query` for this account, so it
contributed nothing. Recorded rather than quietly dropped.

`PROVISIONAL` — informs the board design; nothing here is adopted by itself.

---

## 1. The sidebar must dock, never overlay

**opencode #41203** — *"Sidebar overlay hides chat content and interrupts session
switching — poor UX in Desktop v1.18.15"*. A regression turned the sidebar from a
persistent column into a floating overlay (`absolute` + `z-30`):

> When the sidebar is opened, it covers the chat area instead of shrinking it,
> which frequently hides the active session… The experience feels very janky.

The filer's preferred fix is explicit: *"Sidebar should remain a static in-flow
column that pushes the chat area"*. They also report hover-peek firing
unintentionally, *"causing flicker and accidental navigation"*.

**Adopted.** The board's sidebar is in-flow. Narrow mode **collapses** it and
reflows the main pane; it never floats over content, and there is no hover-peek.

## 2. Users already built the subagent sidebar we need

**opencode #41249 / #41248** — *"Live Subagents sidebar section in the TUI"*. A
user shipped it as an external plugin (`opencode-subagents-view`) and is asking
for it built in. What they built:

> direct child sessions for the current session, with a per-row status icon,
> live activity text (current tool/step), and idle-run reset behavior when a new
> run starts

And, notably for us:

> adapted to match this repo's conventions (`packages/tui/src/feature-plugins/sidebar/*`,
> same order/id/state-access patterns as `context.tsx`/`lsp.tsx`/`todo.tsx`)

They cite three prior requests for the same thing — #15223 (subagents view in the
TUI), #28175 (live session status panel in sidebar), #36042 (a thinner PR: count
plus five titles, no per-row status or live activity).

**Adopted.** This is the orchestrator and fanout surface, validated by demand,
and it belongs in the sidebar. Ranex's version adds what a governance tool needs
and theirs cannot: each child's **approved scope** and whether its result was
accepted. #36042's thin form — a count and some titles — is the version to avoid;
per-row status is the whole value.

## 3. Orchestration needs glanceable completion

**kilocode #7024** — *"Orchestration mode small ui feedback"*:

> Create a small UI indicator that indicates whether a general agent task is
> already finished. Maybe introduce a green border

Related open confusion in the same repo: *"Orchestrator mode should not perform
coding tasks directly"*, *"Silent fallback to default model during subagent task
delegation"*, *"Orchestrator mode failing at resume"*.

**Adopted with a change.** Completion must be glanceable — but a green border
alone encodes state in colour, which fails for colour-blind users and dies in
`NO_COLOR`. Ranex spells the state and lets colour reinforce it.

**Also adopted:** the "silent fallback" complaint is the same class of defect the
kernel already refuses. A child that silently ran under a different model than
approved must be visible, not inferred.

## 4. Flicker and resize are the top rendering complaints

**gemini-cli**, multiple open issues — *"Flicker free robust terminal
rendering"*, *"High performance and flicker free behavior on terminal resize"*,
*"interactive prompt input line flickers in agent mode"*, *"Rendering glitch with
nested scrollbars and wrapped lines"*. One filer asks specifically for
**Synchronized Output** (`DCS = 1 s ST`) to stop tmux spinner flicker.

**Adopted.** This is exactly why `lazygit-layout.go` is cited in ADR-018: it
recomputes layout every frame but **diffs against `PrevLayout` before writing**.
Synchronized Output is a concrete technique to evaluate in BOARD-04.

## 5. Autoscroll fights the reader

**crush** — *"Add a flag to avoid continuous scroll on text generation"*, and
*"A large number of logs leads to inefficiency in troubleshooting and affects
scrolling performance"* (gemini-cli).

**Adopted.** The board is a **table, not a stream**. It does not scroll itself.
Streaming output lives in the run pane, which pins when the operator scrolls up.

## 6. Text selection and copy are table stakes

**crush** — *"Make text selectable"* (closed). Operators copy digests, claim ids
and refusal reasons out of the screen constantly.

**Adopted.** Digests must be selectable and copyable. A governance tool whose
subject digest cannot be copied into a bug report is hostile.

## 7. Keybindings collide and must be remappable

**crush** — *"Terminal shortcut conflicts with Crush shortcuts, suggest adding
shortcut mapping configuration"*.

**Adopted.** Reinforces `k9s`'s keymap-as-data in BOARD-10: if the map is data,
remapping is configuration rather than a fork.

## 8. Collapse and fullscreen are asked for repeatedly

**crush** — *"Feature: Click to collapse sections in right pane"*, *"Better
Output Reading Experience (Popup / Fullscreen View)"*, *"Slow UI responses on
opening an output block of a tool response"*.

**Adopted.** Sidebar panels collapse; any pane opens fullscreen. Large tool
output is bounded and visibly truncated rather than rendered whole — which also
answers the slow-open complaint.

## 9. Context and cost belong on screen

**gemini-cli** — *"no context window % display"* (closed, i.e. users demanded it
and got it). **opencode** — *"account usage display on the tui sidebar"*.

**Adopted, and it maps onto something Ranex is missing.** opencode's Context
panel shows tokens, percent and dollars spent. `MAP` §15.2 lists **budget and
escalation as absent**. The sidebar's Budget panel is where the three-miss stop
becomes visible before it fires, not after.

## 10. Accessibility is filed, and closed, repeatedly

**gemini-cli** — *"User input is not getting picked up by screen readers"*,
*"Accessibility"*, *"Severe screen flickering in interactive mode over SSH"*.

**Adopted as a rule, not a feature:** no state is ever carried by colour or a
glyph alone. Every verdict and cause is spelled. That is what makes the
`NO_COLOR` and no-Unicode renderings lossless, and it is the same property a
screen reader needs.

---

## Deliberately not copied

- **A green border for completion** (kilocode #7024) — colour-only state.
- **The thin subagent panel** (opencode #36042) — a count and titles without
  per-row status is the version users then asked to replace.
- **Hover-peek sidebars** (opencode #41203) — the filer reports accidental
  navigation from mouse movement alone.
- **Desktop and web surfaces** generally — the Web UI is parked (`MAP` §0.14),
  and every citation above that concerns a desktop window is read for its layout
  lesson only.

## What none of them have

Every harness surveyed renders **what the agent did**. None renders **whether the
result is acceptable and why not** — no gate, no evidence, no cause, no approval
identity, no chain. The prior art above is worth copying for how a terminal
should behave. It has nothing to say about the thing Ranex is for, which is why
the board has no template to follow.
