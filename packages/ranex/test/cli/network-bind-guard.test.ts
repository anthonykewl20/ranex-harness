import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@ranex/core/flag/flag"
import { ensureAuthenticatedBind, resolveNetworkOptionsNoConfig } from "../../src/cli/network"

const originalPassword = Flag.RANEX_SERVER_PASSWORD

afterEach(() => {
  Flag.RANEX_SERVER_PASSWORD = originalPassword
})

const args = (overrides: Partial<Parameters<typeof resolveNetworkOptionsNoConfig>[0]> = {}) => ({
  port: 0,
  hostname: "127.0.0.1",
  mdns: false,
  "mdns-domain": "ranex.local",
  cors: [],
  ...overrides,
})

describe("network bind guard", () => {
  test("refuses 0.0.0.0 without a password", () => {
    Flag.RANEX_SERVER_PASSWORD = undefined
    expect(() => resolveNetworkOptionsNoConfig(args({ hostname: "0.0.0.0" }))).toThrow(/RANEX_SERVER_PASSWORD/)
  })

  test("refuses LAN IPs and domains without a password", () => {
    Flag.RANEX_SERVER_PASSWORD = undefined
    expect(() => resolveNetworkOptionsNoConfig(args({ hostname: "192.168.1.5" }))).toThrow(/RANEX_SERVER_PASSWORD/)
    expect(() => resolveNetworkOptionsNoConfig(args({ hostname: "ranex.example" }))).toThrow(/RANEX_SERVER_PASSWORD/)
  })

  test("refuses the mDNS 0.0.0.0 default without a password", () => {
    Flag.RANEX_SERVER_PASSWORD = undefined
    expect(() => resolveNetworkOptionsNoConfig(args({ mdns: true }))).toThrow(/RANEX_SERVER_PASSWORD/)
  })

  test("allows loopback binds without a password", () => {
    Flag.RANEX_SERVER_PASSWORD = undefined
    expect(resolveNetworkOptionsNoConfig(args()).hostname).toBe("127.0.0.1")
    expect(resolveNetworkOptionsNoConfig(args({ hostname: "localhost" })).hostname).toBe("localhost")
    expect(resolveNetworkOptionsNoConfig(args({ hostname: "::1" })).hostname).toBe("::1")
  })

  test("allows network binds with a password", () => {
    Flag.RANEX_SERVER_PASSWORD = "secret"
    expect(resolveNetworkOptionsNoConfig(args({ hostname: "0.0.0.0" }))).toMatchObject({
      hostname: "0.0.0.0",
      mdns: false,
    })
  })

  test("ensureAuthenticatedBind passes loopback without a password", () => {
    Flag.RANEX_SERVER_PASSWORD = undefined
    expect(() => ensureAuthenticatedBind("127.0.0.1")).not.toThrow()
    expect(() => ensureAuthenticatedBind("[::1]")).not.toThrow()
  })
})
