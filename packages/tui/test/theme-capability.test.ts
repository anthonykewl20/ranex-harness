import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { detectCapability, degrade, type ColorCapability } from "../src/theme/capability"
import { ASCII_GLYPHS, UNICODE_GLYPHS, detectGlyphs } from "../src/theme/glyphs"
import { DEFAULT_THEMES, resolveTheme } from "../src/theme"

const UTF8 = { LANG: "en_US.UTF-8", TERM: "xterm-256color" }

function ranex(mode: "dark" | "light" = "dark") {
  return resolveTheme(DEFAULT_THEMES.ranex, mode)
}

describe("capability detection", () => {
  test("a declared value beats detection", () => {
    // lipgloss's LightDark depends on the terminal answering a query. Many
    // never do and no CI does, so a declared default must win.
    expect(detectCapability({ RANEX_COLOR: "none", COLORTERM: "truecolor" }, true)).toBe("none")
    expect(detectCapability({ RANEX_COLOR: "truecolor", NO_COLOR: "1" }, false)).toBe("truecolor")
  })

  test("NO_COLOR disables colour whatever its value, including empty", () => {
    // https://no-color.org — presence is the signal, not the value.
    for (const value of ["", "0", "false", "1"]) {
      expect(detectCapability({ NO_COLOR: value, ...UTF8, COLORTERM: "truecolor" }, true)).toBe("none")
    }
  })

  test("a pipe is never coloured", () => {
    expect(detectCapability({ ...UTF8, COLORTERM: "truecolor" }, false)).toBe("none")
  })

  test("depth comes from COLORTERM then TERM", () => {
    expect(detectCapability({ TERM: "xterm-256color", COLORTERM: "truecolor" }, true)).toBe("truecolor")
    expect(detectCapability({ TERM: "xterm-256color" }, true)).toBe("ansi256")
    expect(detectCapability({ TERM: "xterm" }, true)).toBe("ansi16")
    expect(detectCapability({ TERM: "dumb" }, true)).toBe("none")
    expect(detectCapability({}, true)).toBe("none")
  })

  test("an unrecognised RANEX_COLOR is refused, not ignored", () => {
    // A typo that silently yields full colour is how CI logs fill with escapes.
    expect(() => detectCapability({ RANEX_COLOR: "yes-please" }, true)).toThrow(/RANEX_COLOR/)
  })
})

describe("degradation", () => {
  const CAPABILITIES: ColorCapability[] = ["truecolor", "ansi256", "ansi16", "none"]

  test("no token is ever lost, at any capability", () => {
    // A missing token is a missing cell, and a missing cell is a content change.
    const full = ranex()
    for (const capability of CAPABILITIES) {
      expect(Object.keys(degrade(full, capability)).sort()).toEqual(Object.keys(full).sort())
    }
  })

  test("truecolor is the identity", () => {
    const full = ranex()
    expect(degrade(full, "truecolor")).toBe(full)
  })

  test("none means the terminal's own colours, and backgrounds undrawn", () => {
    // lipgloss NoColor: foreground falls back to the terminal default,
    // background is not drawn at all.
    const bare = degrade(ranex(), "none")
    expect(bare.background.intent).toBe("default")
    expect(bare.backgroundPanel.intent).toBe("default")
    expect(bare.text.intent).toBe("default")
    expect(bare.error.intent).toBe("default")
    expect(bare.background.equals(RGBA.defaultBackground())).toBe(true)
    expect(bare.text.equals(RGBA.defaultForeground())).toBe(true)
  })

  test("indexed capabilities emit indexed colours", () => {
    expect(degrade(ranex(), "ansi16").error.intent).toBe("indexed")
    expect(degrade(ranex(), "ansi256").error.intent).toBe("indexed")
  })

  test("PASS and FAIL stay distinguishable at 16 colours", () => {
    // The whole point. If these collapse onto one index, a verdict becomes
    // unreadable exactly where colour is scarcest.
    for (const mode of ["dark", "light"] as const) {
      const bare = degrade(ranex(mode), "ansi16")
      expect(bare.success.slot).not.toBe(bare.error.slot)
      expect(bare.success.slot).not.toBe(bare.warning.slot)
      expect(bare.error.slot).not.toBe(bare.warning.slot)
    }
  })

  test("a transparent token is not painted by quantisation", () => {
    const theme = { ...ranex(), background: RGBA.fromInts(0, 0, 0, 0) }
    expect(degrade(theme, "ansi16").background.a).toBe(0)
  })

  test("degradation is deterministic", () => {
    const once = degrade(ranex(), "ansi16")
    const twice = degrade(ranex(), "ansi16")
    for (const key of Object.keys(once)) {
      const a = once[key as keyof typeof once]
      const b = twice[key as keyof typeof twice]
      if (a instanceof RGBA && b instanceof RGBA) expect(a.equals(b)).toBe(true)
    }
  })
})

describe("glyphs", () => {
  test("both sets carry the same keys", () => {
    // A glyph missing from one set is a hole that only appears on the terminal
    // least able to report it.
    expect(Object.keys(ASCII_GLYPHS).sort()).toEqual(Object.keys(UNICODE_GLYPHS).sort())
  })

  test("the ASCII set is actually ASCII", () => {
    for (const value of Object.values(ASCII_GLYPHS)) {
      expect(/^[\x20-\x7e]+$/.test(value)).toBe(true)
    }
  })

  test("a non-UTF-8 locale falls back", () => {
    expect(detectGlyphs({ LANG: "C", TERM: "xterm" })).toBe(ASCII_GLYPHS)
    expect(detectGlyphs({ TERM: "xterm" })).toBe(ASCII_GLYPHS)
    expect(detectGlyphs({ ...UTF8 })).toBe(UNICODE_GLYPHS)
  })

  test("RANEX_ASCII is declared, and can be declared off", () => {
    expect(detectGlyphs({ ...UTF8, RANEX_ASCII: "1" })).toBe(ASCII_GLYPHS)
    expect(detectGlyphs({ LANG: "C", RANEX_ASCII: "0", TERM: "xterm" })).toBe(UNICODE_GLYPHS)
  })
})
