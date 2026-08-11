import { detectGlyphs } from "../theme/glyphs"

/**
 * The Ranex working animation.
 *
 * It replaces opencode's `createFrames({ style: "blocks" })` — a solid gradient
 * bar that is that product's signature and, at six cells wide, the loudest thing
 * on the screen while you are trying to read.
 *
 * The shape is a wave travelling through a fixed-width track: the track never
 * changes width, so nothing around it reflows frame to frame. That is the same
 * defect class as claude-code #17887, where an animated terminal title made the
 * tab width change forever — motion must not move the layout.
 *
 * It is also deliberately quiet. A spinner is not information; the state beside
 * it is, and `no state is ever carried by a glyph alone` applies to moving
 * glyphs too. Anything the animation implies is also spelled in words.
 */
const UNICODE = [
  "▁▁▁▁",
  "▂▁▁▁",
  "▃▂▁▁",
  "▄▃▂▁",
  "▅▄▃▂",
  "▆▅▄▃",
  "▇▆▅▄",
  "▆▇▆▅",
  "▅▆▇▆",
  "▄▅▆▇",
  "▃▄▅▆",
  "▂▃▄▅",
  "▁▂▃▄",
  "▁▁▂▃",
  "▁▁▁▂",
] as const

/**
 * ASCII fallback, for a terminal whose font lacks the block range. Same width,
 * same cadence, no information lost — because none was carried here.
 */
const ASCII = [
  "....",
  "-...",
  "=-..",
  "==-.",
  "*==-",
  "#*==",
  "##*=",
  "*##*",
  "=*##",
  "-=*#",
  ".-=*",
  "..-=",
  "...-",
  "....",
  "....",
] as const

/** Chosen once at import, the same way `theme/glyphs.ts` picks its set. */
export const RANEX_SPINNER: string[] = [...(detectGlyphs().ok === "✔" ? UNICODE : ASCII)]

/** Slow enough to read past, fast enough to look alive. */
export const RANEX_SPINNER_INTERVAL = 90
