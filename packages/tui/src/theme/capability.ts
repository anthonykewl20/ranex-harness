import { RGBA } from "@opentui/core"
import type { Theme } from "./index"

/**
 * What the destination can actually paint.
 *
 * BOARD-03. A governance tool whose FAIL is unreadable has failed at its one
 * job, and the places that happens — CI logs, 16-colour terminals, NO_COLOR —
 * are exactly where a verdict matters most.
 *
 * Only styling degrades. Content never does: no line is added, removed,
 * reordered or reworded by anything in this file. That rule is enforced on the
 * kernel side by tests/contract/test_verdict_presentation.py.
 */
export type ColorCapability = "truecolor" | "ansi256" | "ansi16" | "none"

const CAPABILITIES: ColorCapability[] = ["truecolor", "ansi256", "ansi16", "none"]

/**
 * Background tokens. Under "none" these are not drawn at all, while everything
 * else falls back to the terminal's own foreground — which is precisely what
 * lipgloss models as NoColor (color.go @5bd778d0): "foreground colors will be
 * rendered with the terminal's default text color, and background colors will
 * not be drawn at all".
 */
const BACKGROUND_TOKENS = new Set<string>([
  "background",
  "backgroundPanel",
  "backgroundElement",
  "backgroundMenu",
  "diffAddedBg",
  "diffRemovedBg",
  "diffContextBg",
  "diffAddedLineNumberBg",
  "diffRemovedLineNumberBg",
])

/**
 * Resolve the capability. A **declared** value always beats detection.
 *
 * lipgloss's LightDark resolves a colour pair against the terminal's answer to a
 * background query, and its own doc comment concedes the workflow differs by
 * host. Many terminals never answer and no CI does, so detection may only
 * refine a declared default — it may never override one. Getting this backwards
 * produces an unreadable UI in exactly the environments that carry evidence.
 */
export function detectCapability(
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): ColorCapability {
  const declared = env.RANEX_COLOR?.trim().toLowerCase()
  if (declared && declared !== "auto") {
    const named = CAPABILITIES.find((item) => item === declared)
    if (named) return named
    // Common spellings people actually type. An unrecognised value is not
    // silently ignored — see the throw below — because a typo that quietly
    // yields full colour is how CI logs fill with escape sequences.
    if (declared === "16") return "ansi16"
    if (declared === "256") return "ansi256"
    if (declared === "24bit" || declared === "full") return "truecolor"
    if (declared === "off" || declared === "no" || declared === "0") return "none"
    throw new Error(
      `RANEX_COLOR="${env.RANEX_COLOR}" is not one of: truecolor, 256, 16, none, auto`,
    )
  }

  // https://no-color.org — presence disables colour, whatever the value, and an
  // empty string counts as present. Checked before isTTY so that an explicit
  // opt-out is honoured even on a terminal.
  if (env.NO_COLOR !== undefined) return "none"

  if (!isTTY) return "none"
  if (env.TERM === "dumb" || env.TERM === undefined) return "none"

  const colorterm = env.COLORTERM?.toLowerCase()
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor"
  if (env.TERM.includes("256color")) return "ansi256"
  return "ansi16"
}

/** The xterm palette, in index order. Mirrors `ansiToRgba` in `./index`. */
const ANSI_16: RGBA[] = [
  "#000000", "#800000", "#008000", "#808000",
  "#000080", "#800080", "#008080", "#c0c0c0",
  "#808080", "#ff0000", "#00ff00", "#ffff00",
  "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
].map((hex) => RGBA.fromHex(hex))

/**
 * At 16 colours a token falls back to its **meaning**, not to its nearest
 * neighbour.
 *
 * Measured, and the reason this table exists: nearest-colour quantisation put
 * `success` (#4FB27E) and `error` (#E07B6F) both on slot 8, bright black. The
 * Ranex palette is deliberately desaturated so it stays readable on its own
 * grounds, and desaturated colours are arithmetically closest to grey. Green
 * and red collapsing onto one grey is precisely the failure that must not
 * happen where colour is scarcest.
 *
 * So green means green. This mirrors Textual's `_generate_ansi`
 * (design.py @1d99508b), which is a separate path rather than a quantisation of
 * the truecolor palette.
 */
const SEMANTIC_SLOT: Record<string, number> = {
  primary: 4, secondary: 8, accent: 4,
  success: 2, error: 1, warning: 3, info: 6,
  text: 7, textMuted: 8,
  border: 8, borderActive: 4, borderSubtle: 8,
  diffAdded: 2, diffRemoved: 1, diffContext: 8,
  diffHighlightAdded: 2, diffHighlightRemoved: 1,
  diffHunkHeader: 4, diffLineNumber: 8,
  markdownText: 7, markdownHeading: 4, markdownLink: 4, markdownLinkText: 6,
  markdownCode: 2, markdownBlockQuote: 8, markdownEmph: 3, markdownStrong: 4,
  markdownHorizontalRule: 8, markdownListItem: 4, markdownListEnumeration: 6,
  markdownImage: 4, markdownImageText: 6, markdownCodeBlock: 7,
  syntaxComment: 8, syntaxKeyword: 4, syntaxFunction: 6, syntaxVariable: 1,
  syntaxString: 2, syntaxNumber: 3, syntaxType: 8, syntaxOperator: 6,
  syntaxPunctuation: 7, selectedListItemText: 7,
}

/** WCAG relative luminance, enough to ask "is this theme dark?". */
function luminance(color: RGBA) {
  const channel = (value: number) => {
    const v = value > 1 ? value / 255 : value
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/**
 * Perceptually weighted distance. Plain Euclidean RGB picks bright yellow for a
 * mid-green often enough to matter when the colour is carrying PASS or FAIL.
 */
function distance(a: RGBA, b: RGBA) {
  return 2 * (a.r - b.r) ** 2 + 4 * (a.g - b.g) ** 2 + 3 * (a.b - b.b) ** 2
}

function nearestIndex(color: RGBA, palette: RGBA[]) {
  return palette.reduce(
    (best, candidate, index) =>
      distance(color, candidate) < distance(color, palette[best]) ? index : best,
    0,
  )
}

/** The 6x6x6 cube plus greyscale ramp, as xterm indexes 16-255. */
const ANSI_256: RGBA[] = Array.from({ length: 240 }, (_, offset) => {
  const index = offset + 16
  if (index < 232) {
    const level = (value: number) => (value === 0 ? 0 : 55 + value * 40)
    const n = index - 16
    return RGBA.fromInts(level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6))
  }
  const grey = 8 + (index - 232) * 10
  return RGBA.fromInts(grey, grey, grey)
})

/**
 * Map a fully resolved palette onto what the destination can paint.
 *
 * Every branch returns the same set of keys. A token never disappears, because
 * a missing token is a missing cell, and a missing cell is a content change.
 */
export function degrade(theme: Theme, capability: ColorCapability): Theme {
  if (capability === "truecolor") return theme

  // Chromatic slots need their bright variants to stay legible on a dark
  // ground, and their normal variants on a light one.
  const dark = theme.background instanceof RGBA && luminance(theme.background) < 0.5

  const convert = (key: string, color: RGBA): RGBA => {
    if (capability === "none") {
      return BACKGROUND_TOKENS.has(key) ? RGBA.defaultBackground() : RGBA.defaultForeground()
    }
    // A fully transparent token stays transparent: it was already "do not
    // paint", and quantising it would paint something.
    if (color.a === 0) return color

    if (capability === "ansi16") {
      // Backgrounds keep the terminal's own. Painting a panel black when the
      // operator runs a light terminal is hostile, and the diff row markers are
      // text, so no state is lost with the tint.
      if (BACKGROUND_TOKENS.has(key)) return RGBA.defaultBackground()
      const slot = SEMANTIC_SLOT[key]
      if (slot === undefined) return RGBA.fromIndex(nearestIndex(color, ANSI_16))
      return RGBA.fromIndex(dark && slot >= 1 && slot <= 6 ? slot + 8 : slot)
    }

    // 256 colours carry the palette closely enough that nearest-colour keeps
    // every distinction the design intended.
    return RGBA.fromIndex(nearestIndex(color, ANSI_256) + 16)
  }

  return Object.fromEntries(
    Object.entries(theme).map(([key, value]) =>
      value instanceof RGBA ? [key, convert(key, value)] : [key, value],
    ),
  ) as Theme
}
