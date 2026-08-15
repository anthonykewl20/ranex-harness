export * as SecureHttp from "./secure-http"

import { lookup as nodeDnsLookup } from "node:dns/promises"
import http from "node:http"
import https from "node:https"
import type { LookupFunction } from "node:net"
import { Readable } from "node:stream"
import { Effect } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export type Lookup = (host: string) => Promise<Array<{ address: string }>>

export const lookupDns: Lookup = (host) => nodeDnsLookup(host, { all: true, verbatim: true })

const ipv4Octets = (host: string) => {
  const parts = host.split(".")
  if (parts.length !== 4) return undefined
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  return octets.some((octet) => Number.isNaN(octet) || octet > 255) ? undefined : octets
}

// IANA IPv4 Special-Purpose Address Registry (2025-10 revision), plus
// 224.0.0.0/4 multicast: every block that is not globally-reachable unicast
// space. Entries are inclusive [low, high] bounds on the 32-bit address, so
// anything outside the table is the only IPv4 space the guard lets through.
const BLOCKED_IPV4: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8 "this network"
  [0x0a000000, 0x0affffff], // 10.0.0.0/8 private use
  [0x64400000, 0x67ffffff], // 100.64.0.0/10 shared (CGNAT)
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 loopback
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local
  [0xac100000, 0xac1fffff], // 172.16.0.0/12 private use
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24 TEST-NET-1 (documentation)
  [0xc0586300, 0xc05863ff], // 192.88.99.0/24 deprecated 6to4 relay anycast
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16 private use
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 benchmarking
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24 TEST-NET-2 (documentation)
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24 TEST-NET-3 (documentation)
  [0xe0000000, 0xefffffff], // 224.0.0.0/4 multicast
  [0xf0000000, 0xffffffff], // 240.0.0.0/4 reserved, incl. 255.255.255.255
]

const isPrivateIPv4 = ([a, b, c, d]: number[]) => {
  const value = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
  return BLOCKED_IPV4.some(([low, high]) => value >= low && value <= high)
}

// Expand an IPv6 literal (zone IDs stripped, embedded IPv4 converted) into 8 numeric groups
const expandIPv6 = (host: string) => {
  let text = host.split("%")[0]
  const lastColon = text.lastIndexOf(":")
  const tail = text.slice(lastColon + 1)
  if (tail.includes(".")) {
    const mapped = ipv4Octets(tail)
    if (!mapped) return undefined
    text = `${text.slice(0, lastColon + 1)}${((mapped[0] << 8) | mapped[1]).toString(16)}:${((mapped[2] << 8) | mapped[3]).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const parse = (side: string) =>
    side
      .split(":")
      .filter((group) => group !== "")
      .map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN))
  const head = parse(halves[0] ?? "")
  const trailing = parse(halves[1] ?? "")
  if (head.some(Number.isNaN) || trailing.some(Number.isNaN)) return undefined
  if (halves.length === 1) return head.length === 8 ? head : undefined
  const fill = 8 - head.length - trailing.length
  if (fill < 0) return undefined
  return [...head, ...Array<number>(fill).fill(0), ...trailing]
}

const isPrivateIPv6 = (groups: number[]) => {
  const [a, b] = groups
  if (groups.every((group) => group === 0)) return true
  if (a === 0 && groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  const embeddedIPv4 = [
    (groups[6]! >> 8) & 0xff,
    groups[6]! & 0xff,
    (groups[7]! >> 8) & 0xff,
    groups[7]! & 0xff,
  ]
  // ::ffff:0:0/96 IPv4-mapped addresses inherit the IPv4 private ranges
  if (a === 0 && b === 0 && groups.slice(2, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isPrivateIPv4(embeddedIPv4)
  }
  // 2002::/16 6to4 relays carry the public IPv4 endpoint in groups 1–2; that
  // embedded address inherits the IPv4 private ranges
  if (a === 0x2002) return isPrivateIPv4([(b >> 8) & 0xff, b & 0xff, (groups[2]! >> 8) & 0xff, groups[2]! & 0xff])
  // 64:ff9b::/96 well-known NAT64 prefix: the translated IPv4 address occupies
  // the low 32 bits and inherits the IPv4 private ranges
  if (a === 0x0064 && b === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return isPrivateIPv4(embeddedIPv4)
  }
  // ::a.b.c.d IPv4-compatible addresses inherit the IPv4 private ranges; :: and
  // ::1 variants are already blocked by the all-zero and ::1 checks above
  if (a === 0 && b === 0 && groups.slice(2, 6).every((group) => group === 0) && (groups[6] !== 0 || groups[7] !== 0)) {
    return isPrivateIPv4(embeddedIPv4)
  }
  if ((a & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((a & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true // ff00::/8 multicast
  // 100::/64 discard-only and 100:0:0:1::/64 dummy prefixes (IANA registry)
  if (a === 0x0100 && b === 0 && groups[2] === 0 && (groups[3] === 0 || groups[3] === 1)) return true
  // 64:ff9b:1::/48 local-use NAT64; the /96 delegation above excludes it
  if (a === 0x0064 && b === 0xff9b && groups[2] === 1) return true
  // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID) and the
  // separate 2001:db8::/32 documentation prefix
  if (a === 0x2001 && ((b & 0xfe00) === 0 || b === 0x0db8)) return true
  // 3fff::/20 documentation, 5f00::/16 SRv6 SIDs
  if (a === 0x3fff && (b & 0xf000) === 0) return true
  if (a === 0x5f00) return true
  return false
}

// Bun's URL.hostname keeps the brackets on IPv6 literals, so strip them. Strip exactly
// one trailing FQDN dot as well: resolvers ignore it, so 127.0.0.1. must be checked as
// 127.0.0.1 before it ever reaches the transport.
const hostnameOf = (url: URL) => url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "")

// SSRF guard: reject private, reserved, and loopback targets before any request is made
export const assertPublicHttpUrl = (value: string) => {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must start with http:// or https://")
  }
  const host = hostnameOf(url)
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error(`Refusing to fetch private host: ${host}`)
  }
  const octets = ipv4Octets(host)
  if (octets && isPrivateIPv4(octets)) throw new Error(`Refusing to fetch private host: ${host}`)
  const ipv6 = expandIPv6(host)
  if (ipv6 && isPrivateIPv6(ipv6)) throw new Error(`Refusing to fetch private host: ${host}`)
  return url
}

// Classify one resolved address: private/reserved/unparseable answers throw, public
// answers pass through with the family node needs to connect.
const checkedAddress = (host: string, address: string) => {
  const octets = ipv4Octets(address)
  if (octets) {
    if (isPrivateIPv4(octets)) throw new Error(`Refusing to fetch private host: ${host} resolves to ${address}`)
    return { address, family: 4 as const }
  }
  const ipv6 = expandIPv6(address)
  if (!ipv6 || isPrivateIPv6(ipv6)) throw new Error(`Refusing to fetch private host: ${host} resolves to ${address}`)
  return { address, family: 6 as const }
}

// Resolve-and-validate: when the host is a domain name (not an IP literal, not an
// already-decided local name), it must resolve and EVERY returned address must pass the
// same IP-range checks, so resolver tricks (nip.io/sslip.io, rebinding) cannot reach
// private ranges. Resolution failure rejects (fail-closed).
export const resolveAndValidate = async (url: URL, lookup: Lookup = lookupDns) => {
  const host = hostnameOf(url)
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return
  if (ipv4Octets(host) || expandIPv6(host)) return
  const addresses = await lookup(host).catch(() => {
    throw new Error(`Refusing to fetch unresolvable host: ${host}`)
  })
  if (addresses.length === 0) throw new Error(`Refusing to fetch unresolvable host: ${host}`)
  for (const { address } of addresses) checkedAddress(host, address)
}

export const assertPublicHttpUrlResolved = async (value: string, lookup: Lookup = lookupDns) => {
  const url = assertPublicHttpUrl(value)
  await resolveAndValidate(url, lookup)
  return url
}

// node's lookup callback contract allows an error-only call, but the stdlib signature
// still requires the address slot, so the implementation uses a wider internal shape
type NodeLookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string; family: number }>,
  family?: number,
) => void

// The connection-pinned resolver. node passes this to net.connect instead of calling the
// system resolver, so the socket can only ever connect to addresses that already passed
// the IP-range guard — a rebinding DNS that answers differently than the pre-flight
// lookup is refused here, at the connection.
export const validatedNodeLookup = (resolve: Lookup): LookupFunction => {
  const lookup = (hostname: string, options: { all?: boolean }, callback: NodeLookupCallback) => {
    resolve(hostname).then(
    (addresses) => {
      if (addresses.length === 0) {
        callback(new Error(`Refusing to fetch unresolvable host: ${hostname}`))
        return
      }
      try {
        const validated = addresses.map(({ address }) => checkedAddress(hostname, address))
        if (options?.all) return callback(null, validated)
        const first = validated[0]!
        return callback(null, first.address, first.family)
      } catch (error) {
        return callback(error instanceof Error ? error : new Error(String(error)))
      }
    },
    (error) => callback(error instanceof Error ? error : new Error(String(error))),
  )
  }
  return lookup as LookupFunction
}

// Node-native transport whose DNS resolution IS the validated resolver. node never
// follows redirects on its own, so the caller keeps per-hop URL validation.
export const secureHttpClient = (lookup: Lookup): HttpClient.HttpClient =>
  HttpClient.make((request, url, signal) =>
    Effect.map(
      Effect.tryPromise({
        try: () => nodeRequest(request, url, signal, lookup),
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause,
              description: cause instanceof Error ? cause.message : undefined,
            }),
          }),
      }),
      (response) => HttpClientResponse.fromWeb(request, response),
    ),
  )

const nodeRequest = (
  request: HttpClientRequest.HttpClientRequest,
  url: URL,
  signal: AbortSignal,
  lookup: Lookup,
) =>
  new Promise<Response>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https.request : http.request
    // Callers only issue body-less GETs; destroy on abort so an interrupted fiber never
    // leaks an in-flight socket.
    const outgoing = transport(
      {
        hostname: url.hostname,
        port: url.port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: request.headers,
        lookup: validatedNodeLookup(lookup),
      },
      (incoming) => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue
          if (Array.isArray(value)) for (const item of value) headers.append(name, item)
          else headers.set(name, value)
        }
        const status = incoming.statusCode ?? 502
        if (status < 200 || status > 599) {
          outgoing.destroy()
          return reject(new Error(`Unexpected HTTP status code: ${status}`))
        }
        // The web Response constructor forbids a body on null-body statuses
        const body =
          status === 204 || status === 205 || status === 304
            ? null
            : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>)
        resolve(new Response(body, { status, headers }))
      },
    )
    signal.addEventListener("abort", () => outgoing.destroy())
    outgoing.on("error", reject)
    outgoing.end()
  })
