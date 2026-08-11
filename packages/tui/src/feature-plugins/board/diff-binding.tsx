import type { TuiPluginApi } from "@ranex/plugin/tui"
import type { SnapshotFileDiff, VcsFileDiff } from "@ranex/sdk/v2"
import { Match, Switch } from "solid-js"
import { detectGlyphs } from "../../theme/glyphs"

/**
 * Binding a diff to the subject digest it is supposed to be about — BOARD-09.
 *
 * All of this lives here rather than in `system/diff-viewer.tsx` because that
 * file is opencode's, not ours. It sits two lines from the fork base, and
 * ADR-018 keeps the board additive precisely so the fork stays rebasable:
 * *divergence from upstream confined to files upstream does not own*. An earlier
 * version of this feature put 121 lines into the viewer, which would have made
 * every future upstream change to it a conflict, forever, for one pane.
 *
 * The viewer keeps only what cannot live outside it — a route parameter and the
 * calls into this module. The judgement is all here.
 */

const glyphs = detectGlyphs()

/** Beyond this, a patch is summarised rather than rendered. */
export const DIFF_PATCH_MAX_CHARACTERS = 40_000

export type DiffFile = {
  readonly file: string
  readonly patch?: string
  /**
   * Why there is no patch to show. Present only on the subject-bound path, so
   * the ordinary working-tree diff keeps upstream's own wording.
   */
  readonly patchNotice?: string
  readonly additions: number
  readonly deletions: number
  readonly status: "added" | "deleted" | "modified"
}

export type SubjectDiffBinding = {
  readonly verdictDigest: string
  readonly diffDigest: string
  readonly workingTreeDigest: string
  readonly reviewState: "reviewed" | "not-reviewed"
  readonly files: readonly (VcsFileDiff | SnapshotFileDiff)[]
}

/**
 * Three states, and the order of the checks is the point.
 *
 * `mismatched` first: a diff of another tree is not a stale view of this one, it
 * is evidence about something else, and it must never render as the reviewed
 * change. `stale` second: the right tree, but the working copy has moved since
 * the verdict, so the recorded review belongs to the snapshot and not to what is
 * on disk now.
 */
export function subjectDiffBindingState(binding: SubjectDiffBinding) {
  if (binding.diffDigest !== binding.verdictDigest) return "mismatched" as const
  if (binding.workingTreeDigest !== binding.verdictDigest) return "stale" as const
  return "current" as const
}

export function prepareBoundDiffFiles(
  diffs: readonly (VcsFileDiff | SnapshotFileDiff)[],
): DiffFile[] {
  return diffs.flatMap((item) =>
    item.file
      ? [
          {
            file: item.file,
            ...boundPatch(item),
            additions: item.additions,
            deletions: item.deletions,
            status: item.status ?? "modified",
          },
        ]
      : [],
  )
}

/** A mismatched diff yields no files at all, so there is nothing to mistake. */
export function subjectDiffFiles(binding: SubjectDiffBinding) {
  if (subjectDiffBindingState(binding) === "mismatched") return []
  return prepareBoundDiffFiles(binding.files)
}

/**
 * Why a patch is not rendered, said out loud. Rendering a binary blob as text
 * produces garbage an operator may read as a change; saying nothing at all
 * produces a file that looks reviewed. Both are worse than a sentence.
 */
function boundPatch(item: VcsFileDiff | SnapshotFileDiff) {
  if (!item.patch) {
    return { patchNotice: "PATCH NOT AVAILABLE — binary or oversized content; file summary only." }
  }
  if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(item.patch)) {
    return { patchNotice: "BINARY FILE — patch not rendered; file summary only." }
  }
  const characters = Array.from(item.patch).length
  if (characters > DIFF_PATCH_MAX_CHARACTERS) {
    return {
      patchNotice: `PATCH TRUNCATED — too large to render; ${characters} characters withheld; file summary only.`,
    }
  }
  if (item.additions + item.deletions > 0 && !/^@@/m.test(item.patch)) {
    return { patchNotice: "PATCH NOT RENDERED — binary or oversized content; file summary only." }
  }
  return { patch: item.patch }
}

/**
 * The digests, always. An exported or screenshotted diff that does not name the
 * tree it is about proves nothing about that tree, and this viewer is the place
 * an operator decides whether a change has been read.
 *
 * Every state is spelled out in words; the colour is redundant, because glyphs
 * fall back to ASCII and not every operator can tell red from green.
 */
export function SubjectBindingNotice(props: { api: TuiPluginApi; binding: SubjectDiffBinding }) {
  const theme = () => props.api.theme.current
  const state = () => subjectDiffBindingState(props.binding)
  const recorded = () => (props.binding.reviewState === "reviewed" ? "REVIEWED" : "NOT REVIEWED")

  return (
    <box flexShrink={0} paddingLeft={1}>
      <text fg={theme().text}>verdict subject digest {props.binding.verdictDigest}</text>
      <text fg={theme().text}>diff tree digest {props.binding.diffDigest}</text>
      <text fg={theme().text}>working tree digest {props.binding.workingTreeDigest}</text>
      <Switch>
        <Match when={state() === "mismatched"}>
          <text fg={theme().error}>
            {glyphs.no} REFUSED — diff digest {props.binding.diffDigest} does not match verdict digest{" "}
            {props.binding.verdictDigest}.
          </text>
          <text fg={theme().error}>
            REVIEW STATE: REFUSED — recorded {recorded()} state is not applied to this change.
          </text>
        </Match>
        <Match when={state() === "stale"}>
          <text fg={theme().warning}>
            {glyphs.warn} STALE — working tree {props.binding.workingTreeDigest} moved from verdict subject{" "}
            {props.binding.verdictDigest}.
          </text>
          <text fg={theme().warning}>
            REVIEW STATE: STALE — recorded {recorded()} state belongs only to the bound snapshot below.
          </text>
        </Match>
        <Match when={state() === "current"}>
          <text fg={theme().success}>{glyphs.ok} BOUND — diff and verdict name the same current tree.</text>
          <text fg={props.binding.reviewState === "reviewed" ? theme().success : theme().warning}>
            REVIEW STATE: {recorded()}
            {props.binding.reviewState === "reviewed" ? " — independently read." : " — nobody independent has read this."}
          </text>
        </Match>
      </Switch>
      <text fg={theme().textMuted}>Reviewing is not approving. This viewer records no verdict.</text>
    </box>
  )
}

/** Shown instead of the patches when the diff is about another tree. */
export function SubjectRefusalNotice(props: { api: TuiPluginApi }) {
  return (
    <box flexGrow={1} paddingLeft={1}>
      <text fg={props.api.theme.current.error}>
        {glyphs.no} REFUSED — the mismatched diff is not rendered as the reviewed change.
      </text>
    </box>
  )
}
