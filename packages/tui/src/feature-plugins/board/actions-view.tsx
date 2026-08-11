import type { TuiPluginApi } from "@ranex/plugin/tui"
import { For, Show } from "solid-js"
import { detectGlyphs } from "../../theme/glyphs"
import { BOARD_ACTIONS, type BoardActionOutcome, type BoardActionState } from "./actions"

const glyphs = detectGlyphs()

/**
 * The verbs, and what the last one did.
 *
 * Both read the same table the keymap is built from, so the footer cannot drift
 * from the bindings — the drift k9s avoids by binding keys as data.
 */
export function BoardActions(props: {
  readonly api: TuiPluginApi
  readonly state: BoardActionState
  readonly outcome: BoardActionOutcome | undefined
}) {
  const theme = () => props.api.theme.current

  return (
    <box gap={1}>
      <box flexDirection="row" gap={2}>
        <For each={BOARD_ACTIONS}>
          {(action) => {
            const legal = () => action.legalIn.includes(props.state)
            return (
              <box flexDirection="row" gap={1}>
                <text fg={legal() ? theme().primary : theme().textMuted}>
                  <b>{action.key}</b>
                </text>
                {/*
                  An unavailable verb is still listed, and still says it is
                  unavailable in words. Hiding it would leave the operator
                  guessing whether the board can do the thing at all; dimming it
                  alone would carry the state in colour, which ASCII terminals
                  and colour-blind operators do not receive.
                */}
                <text fg={legal() ? theme().text : theme().textMuted}>
                  {action.id}
                  {legal() ? "" : " (unavailable)"}
                </text>
              </box>
            )
          }}
        </For>
      </box>

      <Show when={props.outcome}>{(outcome) => <Outcome api={props.api} outcome={outcome()} />}</Show>
    </box>
  )
}

/**
 * Four outcomes, four renderings, each naming its kind in words.
 *
 * `undeliverable` is the one worth the care: it is not a failure of the request
 * and not a success of it. The operator asked for something the board agrees is
 * reasonable and cannot pass on. Rendering that as either would be a lie in one
 * direction or the other.
 */
function Outcome(props: { readonly api: TuiPluginApi; readonly outcome: BoardActionOutcome }) {
  const theme = () => props.api.theme.current
  const outcome = () => props.outcome

  switch (outcome().kind) {
    case "done":
      return (
        <text fg={theme().success}>
          {glyphs.ok} DONE — {(outcome() as { detail: string }).detail}
        </text>
      )
    case "unchanged":
      return (
        <text fg={theme().textMuted}>
          {glyphs.dot} UNCHANGED — {(outcome() as { detail: string }).detail}
        </text>
      )
    case "refused":
      return (
        <text fg={theme().error}>
          {glyphs.no} REFUSED — {(outcome() as { reason: string }).reason}
        </text>
      )
    case "undeliverable":
      return (
        <box>
          <text fg={theme().warning}>
            {glyphs.warn} REQUESTED, NOT DELIVERED — {(outcome() as { reason: string }).reason}
          </text>
          <text fg={theme().textMuted}>
            The kernel has not seen this request and has decided nothing. Judge from the CLI.
          </text>
        </box>
      )
  }
}
