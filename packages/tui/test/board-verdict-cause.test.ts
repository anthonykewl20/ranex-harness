import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { KNOWN_CAUSES } from "@ranex/schema/verdict"
import { ASCII_GLYPHS } from "../src/theme/glyphs"
import { DEFAULT_THEMES, resolveTheme } from "../src/theme"
import { causePresentation, classifyCause } from "../src/feature-plugins/board/verdict-cause"

const theme = resolveTheme(DEFAULT_THEMES.ranex, "dark")
const source = readFileSync(path.join(import.meta.dir, "../src/feature-plugins/board/verdict-cause.ts"), "utf8")

describe("BOARD-03 verdict cause presentation", () => {
  test("renders every cause in the authoritative closed set", () => {
    const rendered = KNOWN_CAUSES.map((cause) => causePresentation(cause, theme, ASCII_GLYPHS))

    expect(rendered.map((item) => item.word)).toEqual([...KNOWN_CAUSES])
    expect(rendered.every((item) => item.glyph.length > 0)).toBe(true)
    expect(rendered.every((item) => item.color !== undefined)).toBe(true)
  })

  test("handles the unknown wire cause explicitly as blocking unclassified", () => {
    expect(classifyCause("unclassified")).toBe("unclassified")
    expect(classifyCause("future-kernel-cause")).toBe("unclassified")
    expect(causePresentation("unclassified", theme, ASCII_GLYPHS)).toEqual({
      word: "unclassified",
      explanation: "unknown cause; blocks",
      glyph: ASCII_GLYPHS.flag,
      color: theme.error,
    })
  })

  test("compile-enforces the closed cause match without a default arm", () => {
    expect(source).not.toMatch(/\bdefault\s*:/)
    expect(source).toContain("const exhaustive: never = cause")
    expect([...source.matchAll(/case "([^"]+)"/g)].map((item) => item[1])).toEqual([...KNOWN_CAUSES, "unclassified"])
  })

  test("does not rank causes or parse verdict prose", () => {
    expect(source).not.toMatch(/\b(?:sort|toSorted|localeCompare|severity|rank|score|priority|weight)\b/)
    expect(source).not.toMatch(/\.reason\b/)
  })
})
