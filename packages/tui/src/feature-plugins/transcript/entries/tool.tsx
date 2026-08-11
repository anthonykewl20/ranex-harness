import { createSignal } from "solid-js"
import { EntryFrame } from "../frame"
import { Diff, toolDiff } from "../render/diff"
import { Code, Output } from "../render/output"
import type { TranscriptEntry } from "../entry"
import { readDensity, startsOpen } from "../density"

/**
 * CHAT-06 — the tool entry, and the largest complaint class in the field.
 *
 * claude-code #57060: tool output expanded by default with a collapse toggle
 * that does nothing. #56423: no setting, inconsistent across machines. Upstream
 * from the other side: opencode #14511, #14640, #15488 all ask for a way to
 * collapse or hide it.
 *
 * So: **collapsed by default, and the collapsed line carries the outcome.** A
 * collapsed line showing only the tool name is #57060's defect with a working
 * toggle — the reader still has to expand to learn what happened.
 */

/** Middle truncation: a path's identifying part is its end, so never cut the tail. */
export function truncateMiddle(value: string, max = 48): string {
  if (value.length <= max) return value
  const head = Math.ceil((max - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - (max - 1 - head))}`
}

/** The subject: what the call was *about*, spelled, never an emoji. */
export function toolSubject(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  for (const key of ["filePath", "path", "pattern", "command", "url", "description"]) {
    const value = input[key]
    if (typeof value === "string" && value.length > 0) return truncateMiddle(value)
  }
  return ""
}

/**
 * The outcome column. Never blank, and never carried by colour alone: a failure
 * says so in words, which is what keeps it legible under NO_COLOR and to a
 * screen reader (ux-research.md §10).
 */
export function toolOutcome(state: { status?: string; error?: unknown } | undefined): string | undefined {
  const status = state?.status
  // Success is silent. `done` on every line is a column of the same word
  // repeated down the screen: it distinguishes nothing, because everything says
  // it, and it drowns the one line that says something else. What earns a word
  // is the exception — and a real measurement (`+2 −1`) still overrides this.
  if (status === "completed") return undefined
  if (status === "error") return "failed"
  if (status === "running") return "running"
  if (status === "pending") return "queued"
  return status
}

/** The path a change touched, for the diff's syntax highlighting. */
function stringInput(input: Record<string, unknown> | undefined): string | undefined {
  const value = input?.filePath ?? input?.path
  return typeof value === "string" ? value : undefined
}

/**
 * `+N −M` from a unified diff, so the collapsed line says how big the change is.
 * A change whose size is only visible after expanding is #57060 again.
 */
export function diffStat(diff: string | undefined): string | undefined {
  if (!diff) return undefined
  let added = 0
  let removed = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  return `+${added} \u2212${removed}`
}

export const ToolEntry: TranscriptEntry<"tool"> = {
  id: "ranex.transcript.tool",
  kind: "tool",
  order: 400,
  render: (props) => {
    const [open, setOpen] = createSignal(startsOpen(readDensity(props.api)))
    const part = () => props.item.part as unknown as { tool?: string; state?: Record<string, unknown> }
    const state = () =>
      part().state as {
        status?: string
        input?: Record<string, unknown>
        output?: unknown
        metadata?: Record<string, unknown>
      }
    const diff = () => toolDiff(state())
    const written = () => {
      const content = state()?.input?.content
      return typeof content === "string" && content.length > 0 ? content : undefined
    }

    return (
      <box onMouseDown={() => setOpen((x) => !x)}>
        <EntryFrame
          api={props.api}
          label={part().tool ?? "tool"}
          quiet
          detail={toolSubject(state()?.input)}
          outcome={diffStat(diff()) ?? toolOutcome(state())}
        >
          {open() ? (
            diff() ? (
              // A change with removals to contrast against: added and removed
              // rows, tinted, with line numbers.
              <Diff content={diff()!} path={stringInput(state()?.input)} stat={diffStat(diff())} />
            ) : written() ? (
              // A newly written file has nothing to contrast against, so a wall
              // of `+` lines says less than a line-numbered listing does.
              <Code content={written()!} path={stringInput(state()?.input)} />
            ) : (
              <Output
                content={typeof state()?.output === "string" ? (state().output as string) : ""}
                title={stringInput(state()?.input) ?? toolSubject(state()?.input)}
              />
            )
          ) : null}
        </EntryFrame>
      </box>
    )
  },
}
