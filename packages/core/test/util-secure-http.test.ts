import { describe, expect, test } from "bun:test"
import { SecureHttp } from "@ranex/core/util/secure-http"

const lookupOf = (addresses: Array<{ address: string }>) => () => Promise.resolve(addresses)

const invoke = (lookup: SecureHttp.Lookup, all: boolean) =>
  new Promise<{
    error?: Error
    address?: string
    family?: number
    addresses?: Array<{ address: string; family: number }>
  }>((resolve) => {
    SecureHttp.validatedNodeLookup(lookup)("host.example.com", { all }, (error, address, family) => {
      resolve({
        error: error ?? undefined,
        addresses: Array.isArray(address) ? address : undefined,
        address: typeof address === "string" ? address : undefined,
        family,
      })
    })
  })

describe("SecureHttp syntax guard", () => {
  test("rejects non-http schemes and local names", () => {
    expect(() => SecureHttp.assertPublicHttpUrl("file:///etc/passwd")).toThrow("URL must start with http://")
    expect(() => SecureHttp.assertPublicHttpUrl("ftp://example.com/file")).toThrow("URL must start with http://")
    for (const url of ["http://localhost/", "http://api.localhost/", "http://intranet.local/"]) {
      expect(() => SecureHttp.assertPublicHttpUrl(url)).toThrow("Refusing to fetch private host")
    }
  })

  test("rejects private and reserved literals including trailing-dot and IPv6 forms", () => {
    for (const url of [
      "http://127.0.0.1./admin",
      "http://169.254.169.254./",
      "http://0x7f.000.000.001/admin",
      "http://[::ffff:127.0.0.1]/",
      "http://[::127.0.0.1]/",
      "http://[::169.254.169.254]/",
      "http://[::1]/",
      "http://[::]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      // IANA special-use space the old classifier missed: benchmarking,
      // TEST-NETs, IETF assignments, 6to4 relay, multicast, reserved/broadcast
      "http://198.18.5.5/",
      "http://192.0.2.1/",
      "http://198.51.100.7/",
      "http://203.0.113.9/",
      "http://224.0.0.1/",
      "http://240.1.2.3/",
      "http://255.255.255.255/",
      "http://192.0.0.1/",
      "http://192.88.99.1/",
      // IPv6 documentation, site-local, discard, local-use NAT64, SRv6
      "http://[2001:db8::1]/",
      "http://[fec0::1]/",
      "http://[100::1]/",
      "http://[64:ff9b:1::1]/",
      "http://[5f00::1]/",
      // Translated forms carrying a private embedded IPv4 address
      "http://[64:ff9b::127.0.0.1]/",
      "http://[64:ff9b::169.254.169.254]/",
      "http://[2002:0a00:0001::]/",
      // 100.64.0.0/10 CGNAT including the upper boundary 100.127.255.255
      "http://100.64.0.1/",
      "http://100.127.255.254/",
    ]) {
      expect(() => SecureHttp.assertPublicHttpUrl(url)).toThrow("Refusing to fetch private host")
    }
    expect(SecureHttp.assertPublicHttpUrl("https://Example.COM./path").hostname).toBe("example.com.")
  })

  test("accepts public URLs", () => {
    for (const url of [
      "http://example.com/path",
      "https://1.1.1.1/dns-query",
      "http://[2606:2800:220:1:248:1893:25c8:1946]/",
      // Well-known NAT64 and 6to4 prefixes carrying a genuinely public IPv4
      "http://[64:ff9b::93.184.216.34]/",
      "http://[2002:5db8:d822::]/",
      // Public unicast above the CGNAT block (100.128.0.0 and up) that the
      // old over-broad 100.64.0.0/10 upper bound used to reject
      "http://100.200.1.2/",
      "http://103.1.2.3/",
    ]) {
      expect(SecureHttp.assertPublicHttpUrl(url).protocol.length).toBeGreaterThan(0)
    }
  })
})

describe("SecureHttp resolve-and-validate", () => {
  test("rejects hosts that resolve into private or reserved space", async () => {
    await expect(SecureHttp.resolveAndValidate(new URL("http://mixed.example.com/"), lookupOf([{ address: "93.184.216.34" }, { address: "10.0.0.1" }]))).rejects.toThrow(
      "Refusing to fetch private host: mixed.example.com resolves to 10.0.0.1",
    )
    await expect(
      SecureHttp.resolveAndValidate(new URL("http://v6.example.com/"), lookupOf([{ address: "::ffff:169.254.169.254" }])),
    ).rejects.toThrow("Refusing to fetch private host: v6.example.com resolves to ::ffff:169.254.169.254")
  })

  test("fails closed on resolver errors and empty answers", async () => {
    await expect(
      SecureHttp.resolveAndValidate(new URL("http://missing.example.com/"), () => Promise.reject(new Error("ENOTFOUND"))),
    ).rejects.toThrow("Refusing to fetch unresolvable host: missing.example.com")
    await expect(SecureHttp.resolveAndValidate(new URL("http://empty.example.com/"), lookupOf([]))).rejects.toThrow(
      "Refusing to fetch unresolvable host: empty.example.com",
    )
  })

  test("passes public answers and skips already-decided hosts", async () => {
    await expect(
      SecureHttp.resolveAndValidate(new URL("http://public.example.com/"), lookupOf([{ address: "93.184.216.34" }])),
    ).resolves.toBeUndefined()
    await expect(SecureHttp.resolveAndValidate(new URL("http://1.1.1.1/"), lookupOf([{ address: "127.0.0.1" }]))).resolves.toBeUndefined()
  })
})

describe("SecureHttp validatedNodeLookup", () => {
  test("returns only validated addresses for all-shaped callbacks", async () => {
    const result = await invoke(lookupOf([{ address: "93.184.216.34" }, { address: "2606:2800:220:1:248:1893:25c8:1946" }]), true)
    expect(result.error).toBeUndefined()
    expect(result.addresses).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ])
  })

  test("returns the first validated address for single-shaped callbacks", async () => {
    const result = await invoke(lookupOf([{ address: "93.184.216.34" }]), false)
    expect(result.error).toBeUndefined()
    expect(result.address).toBe("93.184.216.34")
    expect(result.family).toBe(4)
  })

  test("errors the callback when any address is private or reserved", async () => {
    const result = await invoke(lookupOf([{ address: "93.184.216.34" }, { address: "169.254.169.254" }]), true)
    expect(result.error?.message).toBe("Refusing to fetch private host: host.example.com resolves to 169.254.169.254")
    expect(result.addresses).toBeUndefined()
  })

  test("errors the callback on empty or failing resolution (fail-closed)", async () => {
    expect((await invoke(lookupOf([]), true)).error?.message).toBe("Refusing to fetch unresolvable host: host.example.com")
    expect((await invoke(() => Promise.reject(new Error("ENOTFOUND")), true)).error?.message).toBe("ENOTFOUND")
  })
})
