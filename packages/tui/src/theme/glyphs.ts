/**
 * Glyphs, with an ASCII fallback for terminals whose font or encoding cannot
 * carry the Unicode set.
 *
 * BOARD-03. The rule that makes this safe is stated once and holds everywhere:
 *
 *   **No state is ever carried by a glyph alone.**
 *
 * Every verdict and cause is spelled out — PASS, FAIL, absent, refused — and the
 * glyph beside it is redundant. So falling back to ASCII loses no information,
 * because none was ever encoded in the tick. The same property is what makes the
 * board readable to someone who cannot distinguish red from green, and to a
 * screen reader.
 *
 * The shape follows `cliui-icons.ts` @319531c0be1946072e7da29ea45f4514939aff06,
 * which picks one of two sets at import time from the platform. We key on
 * encoding rather than platform, and allow an explicit override, because the
 * failing case is a font that lacks the range — which no platform check detects.
 */
export type GlyphSet = {
  readonly ok: string
  readonly no: string
  readonly warn: string
  readonly flag: string
  readonly right: string
  readonly down: string
  readonly dot: string
  readonly rule: string
  readonly vertical: string
  readonly arrow: string
  readonly branch: string
  readonly leaf: string
  readonly boxTL: string
  readonly boxTR: string
  readonly boxBL: string
  readonly boxBR: string
  readonly boxH: string
  readonly boxV: string
  readonly divider: string
  readonly halfBlock: string
}

export const UNICODE_GLYPHS: GlyphSet = {
  ok: "✓",
  no: "✗",
  warn: "⚠",
  flag: "⚑",
  right: "▸",
  down: "▾",
  dot: "·",
  rule: "─",
  vertical: "│",
  arrow: "→",
  branch: "├─",
  leaf: "└─",
  boxTL: "╭",
  boxTR: "╮",
  boxBL: "╰",
  boxBR: "╯",
  boxH: "─",
  boxV: "│",
  divider: "╹",
  halfBlock: "▀",
}

export const ASCII_GLYPHS: GlyphSet = {
  ok: "+",
  no: "x",
  warn: "!",
  flag: "!",
  right: ">",
  down: "v",
  dot: ".",
  rule: "-",
  vertical: "|",
  arrow: "->",
  branch: "|-",
  leaf: "`-",
  boxTL: "+",
  boxTR: "+",
  boxBL: "+",
  boxBR: "+",
  boxH: "-",
  boxV: "|",
  divider: "|",
  halfBlock: "-",
}

/**
 * Which set to paint with.
 *
 * A declared value wins, for the same reason it wins for colour: detection here
 * is a guess about a font, and a wrong guess renders replacement boxes where a
 * verdict should be. `RANEX_ASCII` set to anything but an explicit off means
 * ASCII.
 */
export function detectGlyphs(env: Record<string, string | undefined> = process.env): GlyphSet {
  const declared = env.RANEX_ASCII?.trim().toLowerCase()
  if (declared !== undefined && declared !== "" && declared !== "0" && declared !== "false") {
    return ASCII_GLYPHS
  }
  if (declared === "0" || declared === "false") return UNICODE_GLYPHS

  // A terminal that cannot say it speaks UTF-8 is assumed not to. This is the
  // conservative direction: ASCII always renders, and a box-drawing character
  // that does not is unreadable rather than merely plain.
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || ""
  if (!/utf-?8/i.test(locale)) return ASCII_GLYPHS
  if (env.TERM === "dumb" || env.TERM === undefined) return ASCII_GLYPHS
  return UNICODE_GLYPHS
}
