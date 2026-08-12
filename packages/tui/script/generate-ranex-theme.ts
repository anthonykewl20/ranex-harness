#!/usr/bin/env bun
/**
 * Generates `src/theme/assets/ranex.json` from Ranex's terminal palette and
 * refuses to emit it if any pair fails its contrast floor.
 *
 * Two ideas, from two places:
 *
 * Textualize/textual `src/textual/design.py` @ 1d99508b928a771b51e1a527319c6b87dcff9e05
 *   declares a handful of semantic colours and derives the rest, instead of
 *   hand-maintaining every value. The old ranex.json hand-coded 38 hex values
 *   per mode under positional names like `darkStep9`, which says nothing about
 *   when to use it.
 *
 * The contrast gate is what `ColorSystem` does NOT do. It shades by luminosity
 * arithmetic and never checks the result against the surface it lands on. A
 * governance tool whose FAIL is hard to read has failed at its one job, so the
 * check is a build gate here rather than a reviewer's eye.
 *
 * Dark-mode warm neutrals are sourced from Kilo Code's `kilo.json` at
 * 64e5dd03633013b4564d0ac759747d606f74522c. Ranex substitutes royal blue for
 * Kilo's yellow main colour and retains semantic ownership of PASS (green) and
 * FAIL (red). Do not edit the generated JSON — edit BASE below and re-run:
 *
 *   bun run packages/tui/script/generate-ranex-theme.ts
 */

type Hex = `#${string}`
type Mode = "dark" | "light"

/**
 * `pass`/`fail` are verdict tokens, not decoration.
 */
const BASE = {
  light: {
    ground: "#F4F6F7",
    surface: "#FFFFFF",
    surface2: "#EDF1F3",
    ink: "#1B2733",
    inkSoft: "#52616E",
    inkWeaker: "#57534d",
    line: "#D9E0E4",
    lineStrong: "#B9C4CC",
    accent: "#2B5C8A",
    accentStrong: "#234C73",
    accentTint: "#E7EEF5",
    pass: "#1E7A45",
    passBg: "#E7F2EB",
    fail: "#B23A32",
    failBg: "#F7E9E7",
    // Derived. The site has no warn/info because a marketing page never has to
    // say "attention, but this is not a verdict".
    warn: "#8A6114",
    warnBg: "#FAF0DC",
    info: "#1F6E73",
    infoBg: "#E3F1F2",
    highlight: "#6A4FB0",
    primaryForeground: "#F4F6F7",
    diffHighlightAdded: "#2f7d32",
    diffHighlightRemoved: "#c00009",
    diffAddedBg: "#e8f5e9",
    diffRemovedBg: "#ffe4e6",
    diffAddedLineNumberBg: "#d7ecd8",
    diffRemovedLineNumberBg: "#ffd4d8",
  },
  dark: {
    ground: "#0c0a09",
    surface: "#292524",
    surface2: "#1c1917",
    ink: "#fafaf9",
    inkSoft: "#a6a09b",
    inkWeaker: "#79716b",
    line: "#44403b",
    lineStrong: "#35312d",
    accent: "#6387FF",
    accentStrong: "#6387FF",
    accentTint: "#151B2D",
    pass: "#89d185",
    passBg: "#122318",
    fail: "#ff6467",
    failBg: "#2a1214",
    warn: "#cca700",
    warnBg: "#292524",
    info: "#3794ff",
    infoBg: "#292524",
    highlight: "#6387FF",
    primaryForeground: "#0c0a09",
    diffHighlightAdded: "#b8db87",
    diffHighlightRemoved: "#ff8587",
    diffAddedBg: "#122318",
    diffRemovedBg: "#2a1214",
    diffAddedLineNumberBg: "#17291b",
    diffRemovedLineNumberBg: "#35181a",
  },
} satisfies Record<Mode, Record<string, Hex>>

type Token = keyof (typeof BASE)["dark"]

/**
 * Semantic key -> base token, identical in both modes. One mapping, so a key
 * cannot drift between light and dark — the failure the old file had.
 */
const MAP: Record<string, Token> = {
  primary: "accent",
  secondary: "inkSoft",
  accent: "accent",
  error: "fail",
  warning: "warn",
  success: "pass",
  info: "info",

  text: "ink",
  textMuted: "inkSoft",
  background: "ground",
  backgroundPanel: "surface2",
  backgroundElement: "surface",
  backgroundMenu: "surface2",
  border: "line",
  borderActive: "accent",
  borderSubtle: "lineStrong",
  selectedListItemText: "primaryForeground",

  diffAdded: "pass",
  diffRemoved: "fail",
  diffContext: "inkSoft",
  diffHunkHeader: "accent",
  diffHighlightAdded: "diffHighlightAdded",
  diffHighlightRemoved: "diffHighlightRemoved",
  diffAddedBg: "diffAddedBg",
  diffRemovedBg: "diffRemovedBg",
  diffContextBg: "surface2",
  diffLineNumber: "inkWeaker",
  diffAddedLineNumberBg: "diffAddedLineNumberBg",
  diffRemovedLineNumberBg: "diffRemovedLineNumberBg",

  markdownText: "ink",
  markdownHeading: "accent",
  markdownLink: "accent",
  markdownLinkText: "info",
  markdownCode: "pass",
  markdownBlockQuote: "inkSoft",
  markdownEmph: "warn",
  markdownStrong: "accent",
  markdownHorizontalRule: "line",
  markdownListItem: "accent",
  markdownListEnumeration: "info",
  markdownImage: "accent",
  markdownImageText: "info",
  markdownCodeBlock: "ink",

  syntaxComment: "inkSoft",
  syntaxKeyword: "accent",
  syntaxFunction: "info",
  syntaxVariable: "fail",
  syntaxString: "pass",
  syntaxNumber: "warn",
  syntaxType: "inkSoft",
  syntaxOperator: "info",
  syntaxPunctuation: "ink",
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: Hex) {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(1 + offset * 2, 3 + offset * 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

/** WCAG 2.1 contrast ratio, 1..21. */
function contrast(a: Hex, b: Hex) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Floors, by what the pair is for. 4.5 is WCAG AA for body text; 3.0 is AA for
 * large text and non-text UI. A border only has to be seen, not read.
 */
const CHECKS: { fg: Token; bg: Token; min: number; why: string }[] = [
  ...(["ground", "surface", "surface2"] as const).flatMap((bg) => [
    { fg: "ink" as Token, bg, min: 4.5, why: "body text" },
    { fg: "inkSoft" as Token, bg, min: 3.0, why: "muted text" },
    // A verdict must be readable on every surface it can land on. This is the
    // check that matters most in this file.
    { fg: "pass" as Token, bg, min: 4.5, why: "PASS on surface" },
    { fg: "fail" as Token, bg, min: 4.5, why: "FAIL on surface" },
    { fg: "warn" as Token, bg, min: 4.5, why: "warning on surface" },
    { fg: "info" as Token, bg, min: 4.5, why: "info on surface" },
    { fg: "accent" as Token, bg, min: 4.5, why: "accent on surface" },
    { fg: "highlight" as Token, bg, min: 4.5, why: "highlight on surface" },
  ]),
  { fg: "pass", bg: "passBg", min: 4.5, why: "diff added" },
  { fg: "fail", bg: "failBg", min: 4.5, why: "diff removed" },
  { fg: "warn", bg: "warnBg", min: 4.5, why: "warning callout" },
  { fg: "info", bg: "infoBg", min: 4.5, why: "info callout" },
  { fg: "primaryForeground", bg: "accent", min: 4.5, why: "selected text on primary" },
  { fg: "diffHighlightAdded", bg: "diffAddedBg", min: 4.5, why: "diff added highlight" },
  { fg: "diffHighlightRemoved", bg: "diffRemovedBg", min: 4.5, why: "diff removed highlight" },
  { fg: "inkWeaker", bg: "surface2", min: 3.0, why: "diff line number on panel" },
  { fg: "line", bg: "ground", min: 1.2, why: "border visible" },
  { fg: "lineStrong", bg: "ground", min: 1.5, why: "strong border visible" },
]

const failures: string[] = []
const report: string[] = []
for (const mode of ["dark", "light"] as const) {
  for (const check of CHECKS) {
    const ratio = contrast(BASE[mode][check.fg], BASE[mode][check.bg])
    const ok = ratio >= check.min
    if (!ok) {
      failures.push(
        `${mode}: ${check.fg} on ${check.bg} = ${ratio.toFixed(2)}:1, needs ${check.min}:1 (${check.why})`,
      )
    }
    report.push(
      `  ${ok ? "PASS" : "FAIL"}  ${mode.padEnd(5)} ${check.fg} on ${check.bg} = ${ratio.toFixed(2)}:1 (min ${check.min})`,
    )
  }
}

console.log(report.join("\n"))

if (failures.length > 0) {
  console.error(`\n${failures.length} contrast failure(s):\n${failures.map((f) => `  ${f}`).join("\n")}`)
  console.error("\nNothing written. Adjust BASE and re-run.")
  process.exit(1)
}

/**
 * Def names stay per-mode and flat because that is what `ThemeJson.defs`
 * accepts, but they are semantic now: `darkPass`, not `darkStep9`.
 */
const defName = (mode: Mode, token: string) => mode + token[0].toUpperCase() + token.slice(1)

await Bun.write(
  new URL("../src/theme/assets/ranex.json", import.meta.url),
  JSON.stringify(
    {
      // Generated. Edit script/generate-ranex-theme.ts, not this file.
      $schema: "https://ranex.dev/theme.json",
      defs: Object.fromEntries(
        (["dark", "light"] as const).flatMap((mode) =>
          Object.keys(BASE[mode]).map((token) => [defName(mode, token), BASE[mode][token as Token]]),
        ),
      ),
      theme: {
        ...Object.fromEntries(
          Object.entries(MAP).map(([key, token]) => [
            key,
            { dark: defName("dark", token), light: defName("light", token) },
          ]),
        ),
        thinkingOpacity: 0.72,
      },
    },
    null,
    2,
  ) + "\n",
)

console.log(`\nWrote ranex.json — ${Object.keys(MAP).length} semantic keys, ${report.length} contrast checks passed.`)
