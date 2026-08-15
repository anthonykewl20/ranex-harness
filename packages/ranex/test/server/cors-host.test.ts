import { describe, expect, test } from "bun:test"
import { isAllowedHost, isAllowedRequestOrigin } from "@ranex/server/cors"

describe("isAllowedHost", () => {
  test("accepts loopback hosts on any port", () => {
    expect(isAllowedHost("localhost:4096")).toBe(true)
    expect(isAllowedHost("LOCALHOST:4096")).toBe(true)
    expect(isAllowedHost("127.0.0.1:4096")).toBe(true)
    expect(isAllowedHost("127.54.99.1:4096")).toBe(true)
    expect(isAllowedHost("[::1]:4096")).toBe(true)
    expect(isAllowedHost("::1")).toBe(true)
  })

  test("accepts direct LAN IP access", () => {
    expect(isAllowedHost("192.168.1.5:4096")).toBe(true)
    expect(isAllowedHost("10.0.0.2:4096")).toBe(true)
    expect(isAllowedHost("[fe80::1]:4096")).toBe(true)
  })

  test("rejects domain-name hosts", () => {
    expect(isAllowedHost("evil.example:4096")).toBe(false)
    expect(isAllowedHost("evil.example")).toBe(false)
    expect(isAllowedHost("sub.evil.example:4096")).toBe(false)
    expect(isAllowedHost(undefined)).toBe(false)
  })

  test("accepts operator-allowlisted domain hosts", () => {
    const opts = { cors: ["https://ranex.example", "https://other.example:8080"] }
    expect(isAllowedHost("ranex.example:4096", opts)).toBe(true)
    expect(isAllowedHost("other.example:8080", opts)).toBe(true)
    expect(isAllowedHost("evil.example:4096", opts)).toBe(false)
  })

  test("blocks rebinding-style Host headers even when Origin matches the Host", () => {
    // The old check trusted origin/host agreement, which an attacker controls
    // together during a rebinding attack.
    expect(isAllowedRequestOrigin("http://evil.example:4096", "evil.example:4096")).toBe(true)
    expect(isAllowedHost("evil.example:4096")).toBe(false)
  })
})
