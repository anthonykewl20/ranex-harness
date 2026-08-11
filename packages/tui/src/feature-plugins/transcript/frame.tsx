import type { TuiPluginApi } from "@ranex/plugin/tui"
import { Show, type JSXElement } from "solid-js"
import type { RGBA } from "@opentui/core"

/**
 * The shared chrome, so entries look like one surface rather than six.
 *
 * The label line lives here and nowhere else. An entry that wants a different
 * one is telling you the label is wrong; change it here for all of them.
 *
 * **Content starts at column 0.** There is no decorative left rule and no
 * persistent indent on a body, because a gutter is copied along with the text —
 * claude-code #75221 is an open request for an option to strip one, and copy is
 * the operation operators perform most. Identity goes above, not beside.
 */
export function EntryFrame(props: {
  api: TuiPluginApi
  label: string
  detail?: string
  outcome?: string
  /**
   * Renders the entry as a panel with an accent bar down its left edge.
   *
   * This is the human's turn, and the shape is the one the owner asked for after
   * seeing the alternatives: a filled block with a coloured rule and inset text,
   * so the two sides alternate unmistakably while scrolling.
   *
   * It does indent the body, which is what claude-code #75221 is about — a
   * gutter is copied along with the text. That objection is answered by scope
   * rather than dismissed: this applies to the message the operator wrote, which
   * they already have. The **assistant's** body, the text people actually copy
   * into bug reports and commits, stays flush at column 0, and
   * `transcript-presentation.test.tsx` holds it there.
   */
  tinted?: boolean
  /**
   * Renders the label at reduced weight, for entries that are not the point.
   *
   * Tool calls and reasoning are what the model did on the way to an answer;
   * the answer is the reason the operator is reading. Given identical weight
   * they compete, and a screen of a dozen bold labels buries the one thing
   * worth reading — which is what the owner saw. Receding them is not
   * decoration, it is the hierarchy doing its job.
   */
  quiet?: boolean
  /** Colour of the label text, by category. Brackets stay dim regardless. */
  tone?: RGBA
  /**
   * Width of the label column, so every subject starts at the same x.
   *
   * This is `cliui-table.ts`'s column algorithm, vendored at
   * `specs/tui-redesign/references/` and cited in ADR-022 — and then not used.
   * It measures the widest cell in a column and sizes the column to it. Hand
   * rolling the rows instead meant `thought`, `read` and `bash` each set their
   * own width, so every subject began at a different x and the whole list read
   * as ragged. One measured column is the difference between a list and a table.
   *
   * Measured with `string-width`, not `.length`, for the reason the reference
   * records: CJK and emoji occupy more columns than they have characters, and
   * `.length` misaligns every row that contains one.
   */
  labelWidth?: number
  children?: JSXElement
}) {
  const theme = () => props.api.theme.current

  return (
    <box
      gap={0}
      marginTop={1}
      flexShrink={0}
      border={props.tinted ? ["left"] : undefined}
      borderColor={props.tinted ? theme().accent : undefined}
      backgroundColor={props.tinted ? theme().backgroundPanel : undefined}
      paddingLeft={props.tinted ? 2 : 0}
      paddingRight={props.tinted ? 1 : 0}
      paddingTop={props.tinted ? 1 : 0}
      paddingBottom={props.tinted ? 1 : 0}
    >
      <box flexDirection="row" gap={1}>
        {/*
          `[ read    ]` — cliui's logger vocabulary, which is what the owner
          pointed at twice. The brackets are constant and dim, the label is
          coloured by category, and the cell is padded to one measured width so
          every subject after it starts at the same x. Hand-rolled rows let each
          verb set its own width, which is what made the list read as ragged.

          The category is carried by the WORD, and colour only reinforces it —
          the same rule the board uses, and what keeps this legible under
          NO_COLOR and to a screen reader.
        */}
        <box flexDirection="row" flexShrink={0} gap={0}>
          <text fg={theme().border} wrapMode="none">
            [{" "}
          </text>
          <box flexShrink={0} minWidth={props.labelWidth}>
            <text fg={props.tone ?? (props.quiet ? theme().textMuted : theme().text)} wrapMode="none">
              {props.quiet ? props.label : <b>{props.label}</b>}
            </text>
          </box>
          <text fg={theme().border} wrapMode="none">
            {" "}]
          </text>
        </box>
        <Show when={props.detail}>
          {/* One line, always. A label that wraps stops being a label: it
              reflows the row, pushes the outcome column out of alignment, and
              turns a one-line summary into a paragraph competing with the body
              it was supposed to summarise. Clipping is the honest failure — the
              full text is one keypress away in the expanded region. */}
          <text fg={theme().textMuted} flexGrow={1} flexShrink={1} wrapMode="none">
            {props.detail}
          </text>
        </Show>
        <Show when={props.outcome}>
          <text fg={theme().textMuted} flexShrink={0} wrapMode="none">
            {props.outcome}
          </text>
        </Show>
      </box>
      {props.children}
    </box>
  )
}

