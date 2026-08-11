import stringWidth from "string-width"
import type { TranscriptItem } from "./entry"

/**
 * The label a row shows in its first column.
 *
 * Kept beside the width calculation rather than inside each entry, because a
 * column can only be sized by something that can see every cell in it.
 */
export function labelOf(item: TranscriptItem): string {
  switch (item.kind) {
    case "user":
      return "you"
    case "assistant":
      return "ranex"
    case "reasoning":
      return "thought"
    case "tool":
      return (item.part as unknown as { tool?: string }).tool ?? "tool"
    case "permission":
      return "approval required"
    case "error":
      return "error"
  }
}

/**
 * Size the label column to its widest cell — `cliui-table.ts`'s
 * `#storeColumnSize`, applied to the labels actually on screen.
 *
 * `string-width`, never `.length`: CJK and emoji occupy more columns than they
 * have characters, and the reference records that `.length` misaligns every row
 * containing one.
 *
 * Bounded, because the column is chrome. `approval required` is deliberately
 * long and would otherwise push every path on screen sideways to accommodate a
 * label that appears once; past the cap it simply overflows into its subject,
 * which costs one row rather than every row.
 */
export const LABEL_COLUMN_MAX = 9

export function labelColumnWidth(labels: readonly string[]): number {
  let width = 0
  for (const label of labels) {
    const size = stringWidth(label)
    if (size > width) width = size
  }
  return Math.min(width, LABEL_COLUMN_MAX)
}
