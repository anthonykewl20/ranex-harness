import { isIP } from "node:net"
import { Context } from "effect"

const opencodeOrigin = /^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/

export type CorsOptions = { readonly cors?: ReadonlyArray<string> }

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@opencode/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  if (input.startsWith("oc://renderer")) return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  if (opencodeOrigin.test(input)) return true
  return opts?.cors?.includes(input) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input, opts)
}

function sameHost(origin: string, host: string) {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function isAllowedHost(host: string | undefined, opts?: CorsOptions) {
  if (!host) return false
  const hostname = hostnameFromHost(host)
  if (!hostname) return false
  if (hostname === "localhost") return true
  // DNS-rebinding attacks work through attacker-controlled domain names that resolve to
  // loopback; direct IP-literal access (loopback or LAN) cannot be rebound, so all IP
  // literals are trusted. Domain names are rejected unless the operator allowlisted them.
  if (isIP(hostname) !== 0) return true
  return (opts?.cors ?? []).some((allowed) => allowlistMatchesHost(allowed, hostname))
}

function hostnameFromHost(host: string) {
  const normalized = host.toLowerCase().trim()
  if (normalized.startsWith("[")) {
    const end = normalized.indexOf("]")
    if (end === -1) return undefined
    return normalized.slice(1, end)
  }
  // A host with more than one colon and no brackets is an unbracketed IPv6 literal,
  // which never carries a port suffix.
  if (normalized.split(":").length > 2) return normalized
  const colon = normalized.indexOf(":")
  return colon === -1 ? normalized : normalized.slice(0, colon)
}

function allowlistMatchesHost(entry: string, hostname: string) {
  if (entry.toLowerCase() === hostname) return true
  try {
    return new URL(entry).hostname === hostname
  } catch {
    return false
  }
}
