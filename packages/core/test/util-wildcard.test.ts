import { describe, expect, test } from "bun:test"
import { Wildcard } from "@ranex/core/util/wildcard"

describe("Wildcard", () => {
  test("matches casing-insensitively by default", () => {
    // The lowercase action vocabulary relies on case-insensitive matching;
    // resource-rule callers narrow this via opts.
    expect(Wildcard.match("secrets/key.pem", "Secrets/*")).toBe(true)
    expect(Wildcard.match("SECRETS/key.pem", "Secrets/*")).toBe(true)
    expect(Wildcard.match("Secrets/key.pem", "secrets/*")).toBe(true)
    expect(Wildcard.match("read", "READ")).toBe(true)
  })

  test("honors the caseInsensitive option", () => {
    // POSIX allow rules pass caseInsensitive: false; the win32 behavior is
    // the default true (callers compute `win32 || effect !== "allow"`).
    expect(Wildcard.match("secrets/x", "Secrets/*", { caseInsensitive: false })).toBe(false)
    expect(Wildcard.match("SECRETS/x", "Secrets/*", { caseInsensitive: false })).toBe(false)
    expect(Wildcard.match("Secrets/x", "Secrets/*", { caseInsensitive: false })).toBe(true)
    expect(Wildcard.match("secrets/x", "Secrets/*", { caseInsensitive: true })).toBe(true)
  })

  test("handles glob tokens", () => {
    expect(Wildcard.match("file1.txt", "file?.txt")).toBe(true)
    expect(Wildcard.match("file12.txt", "file?.txt")).toBe(false)
    expect(Wildcard.match("foo+bar", "foo+bar")).toBe(true)
  })

  test("treats a trailing space+wildcard as optional arguments", () => {
    expect(Wildcard.match("ls", "ls *")).toBe(true)
    expect(Wildcard.match("ls -la", "ls *")).toBe(true)
    expect(Wildcard.match("lstmeval", "ls *")).toBe(false)
    expect(Wildcard.match("git commit -m foo", "git *")).toBe(true)
  })

  test("normalizes slashes before matching", () => {
    expect(Wildcard.match("C:\\Windows\\System32\\drivers", "C:/Windows/System32/*")).toBe(true)
  })
})
