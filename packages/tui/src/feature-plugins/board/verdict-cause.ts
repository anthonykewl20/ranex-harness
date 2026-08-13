import { isKnownCause, type KnownCause } from "@ranex/schema/verdict"
import type { TuiPluginApi } from "@ranex/plugin/tui"
import type { GlyphSet } from "../../theme/glyphs"

export type VerdictCause = KnownCause | "unclassified"

export type CausePresentation = {
  readonly word: VerdictCause
  readonly explanation: string
  readonly glyph: string
  readonly color: CauseTheme["error"]
}

type CauseTheme = Pick<TuiPluginApi["theme"]["current"], "error" | "warning">

/** Keep unknown wire values visible and blocking without widening the closed renderer input. */
export function classifyCause(cause: string): VerdictCause {
  if (isKnownCause(cause)) return cause
  return "unclassified"
}

export function causePresentation(cause: VerdictCause, theme: CauseTheme, glyphs: GlyphSet): CausePresentation {
  switch (cause) {
    case "contradicted":
      return { word: cause, explanation: "evidence disagrees", glyph: glyphs.no, color: theme.error }
    case "failed":
      return { word: cause, explanation: "bound command failed", glyph: glyphs.no, color: theme.error }
    case "mismatched":
      return { word: cause, explanation: "command does not match", glyph: glyphs.warn, color: theme.warning }
    case "stale":
      return { word: cause, explanation: "evidence names another subject", glyph: glyphs.warn, color: theme.warning }
    case "absent":
      return { word: cause, explanation: "work never done", glyph: glyphs.warn, color: theme.warning }
    case "refused":
      return { word: cause, explanation: "record refused", glyph: glyphs.flag, color: theme.error }
    case "unattributable":
      return { word: cause, explanation: "no usable claim", glyph: glyphs.flag, color: theme.error }
    case "unclassified":
      return { word: cause, explanation: "unknown cause; blocks", glyph: glyphs.flag, color: theme.error }
  }
  const exhaustive: never = cause
  return exhaustive
}
