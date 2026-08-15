import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "@ranex/core/permission"

const gitAllow: PermissionV2.Ruleset = [{ action: "bash", resource: "git *", effect: "allow" }]

describe("PermissionV2 bash control-character guard", () => {
  test("a git rule does not match compound, piped, or newline-separated commands", () => {
    for (const command of ["git status; rm -rf /", "git status\nrm -rf /", "git status | sh", "git status & rm -rf /", "echo `rm -rf /`"]) {
      expect(PermissionV2.evaluate("bash", command, gitAllow)).toMatchObject({ effect: "ask" })
    }
  })

  test("the same commands fall through a wildcard allow to ask", () => {
    const wildcard: PermissionV2.Ruleset = [
      { action: "bash", resource: "git *", effect: "allow" },
      { action: "bash", resource: "*", effect: "allow" },
    ]
    expect(PermissionV2.evaluate("bash", "git status; rm -rf /", wildcard)).toMatchObject({ effect: "ask" })
  })

  test("rules whose own resource carries control characters never match bash", () => {
    expect(
      PermissionV2.evaluate("bash", "ls", [{ action: "bash", resource: "ls; rm -rf /", effect: "allow" }]),
    ).toMatchObject({ effect: "ask" })
  })

  test("simple commands still match their approval rules", () => {
    expect(PermissionV2.evaluate("bash", "git status", gitAllow)).toMatchObject({ effect: "allow" })
    expect(PermissionV2.evaluate("bash", "git push origin main", gitAllow)).toMatchObject({ effect: "allow" })
  })

  test("a git rule does not match substitution, redirection, or subshell commands", () => {
    const echoAllow: PermissionV2.Ruleset = [{ action: "bash", resource: "echo *", effect: "allow" }]
    for (const command of ["git status $(rm -rf /)", "git status ${X}", "git status > /etc/passwd", "git status <secret"]) {
      expect(PermissionV2.evaluate("bash", command, gitAllow)).toMatchObject({ effect: "ask" })
    }
    expect(PermissionV2.evaluate("bash", "echo (subshell)", echoAllow)).toMatchObject({ effect: "ask" })
    expect(PermissionV2.evaluate("bash", "git status", gitAllow)).toMatchObject({ effect: "allow" })
  })

  test("non-bash actions are unaffected by control characters", () => {
    expect(
      PermissionV2.evaluate("read", "file;with;semicolons", [
        { action: "read", resource: "file;with;semicolons", effect: "allow" },
      ]),
    ).toMatchObject({ effect: "allow" })
    expect(
      PermissionV2.evaluate("webfetch", "https://example.com/a|b", [
        { action: "webfetch", resource: "https://example.com/*", effect: "allow" },
      ]),
    ).toMatchObject({ effect: "allow" })
    expect(
      PermissionV2.evaluate("read", "file$with(x)>y", [{ action: "read", resource: "file$with(x)>y", effect: "allow" }]),
    ).toMatchObject({ effect: "allow" })
    expect(
      PermissionV2.evaluate("webfetch", "https://example.com/a$(b)<c>", [
        { action: "webfetch", resource: "https://example.com/*", effect: "allow" },
      ]),
    ).toMatchObject({ effect: "allow" })
  })
})
