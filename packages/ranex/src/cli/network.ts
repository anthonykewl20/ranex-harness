import type { Argv, InferredOptionTypes } from "yargs"
import { ConfigV1 } from "@ranex/core/v1/config/config"
import { Flag } from "@ranex/core/flag/flag"
import type { Config } from "@/config/config"
import { Effect } from "effect"

const options = {
  port: {
    type: "number" as const,
    describe: "port to listen on",
    default: 0,
  },
  hostname: {
    type: "string" as const,
    describe: "hostname to listen on",
    default: "127.0.0.1",
  },
  mdns: {
    type: "boolean" as const,
    describe: "enable mDNS service discovery (defaults hostname to 0.0.0.0)",
    default: false,
  },
  "mdns-domain": {
    type: "string" as const,
    describe: "custom domain name for mDNS service (default: ranex.local)",
    default: "ranex.local",
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "additional domains to allow for CORS",
    default: [] as string[],
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}

export function hasArg(name: string) {
  return networkArgs().some((arg) => arg === name || arg.startsWith(name + "="))
}

function hasBooleanArg(name: string) {
  return networkArgs().some(
    (arg) => arg === name || arg === name + "=true" || arg === name + "=false" || arg === "--no-" + name.slice(2),
  )
}

function networkArgs() {
  const separator = process.argv.indexOf("--")
  return process.argv.slice(2, separator === -1 ? undefined : separator)
}

export const resolveNetworkOptions = Effect.fn("Cli.resolveNetworkOptions")(function* (args: NetworkOptions) {
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const config = yield* Config.Service.use((cfg) => cfg.getGlobal())
  return resolveNetworkOptionsNoConfig(args, config)
})

export function resolveNetworkOptionsNoConfig(args: NetworkOptions, config?: ConfigV1.Info) {
  const portExplicitlySet = hasArg("--port")
  const hostnameExplicitlySet = hasArg("--hostname")
  const mdnsExplicitlySet = hasBooleanArg("--mdns")
  const mdnsDomainExplicitlySet = hasArg("--mdns-domain")
  const mdns = mdnsExplicitlySet ? args.mdns : (config?.server?.mdns ?? args.mdns)
  const mdnsDomain = mdnsDomainExplicitlySet ? args["mdns-domain"] : (config?.server?.mdnsDomain ?? args["mdns-domain"])
  const port = portExplicitlySet ? args.port : (config?.server?.port ?? args.port)
  const hostname = hostnameExplicitlySet
    ? args.hostname
    : mdns && !config?.server?.hostname
      ? "0.0.0.0"
      : (config?.server?.hostname ?? args.hostname)
  const configCors = config?.server?.cors ?? []
  const argsCors = Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []
  const cors = [...configCors, ...argsCors]

  ensureAuthenticatedBind(hostname)

  return { hostname, port, mdns, mdnsDomain, cors }
}

function isLoopbackBind(hostname: string) {
  const bare = hostname.toLowerCase()
  const unbracketed = bare.startsWith("[") && bare.endsWith("]") ? bare.slice(1, -1) : bare
  if (unbracketed === "localhost" || unbracketed === "127.0.0.1" || unbracketed === "::1") return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(unbracketed)
}

// A non-loopback bind without a server password exposes an unauthenticated server
// to the network; refuse it instead of warning so the fork's local-only posture
// stays the default.
export function ensureAuthenticatedBind(hostname: string) {
  if (isLoopbackBind(hostname) || Flag.RANEX_SERVER_PASSWORD) return
  throw new Error(
    `Refusing to listen on ${hostname} without authentication: set RANEX_SERVER_PASSWORD or bind a loopback hostname (e.g. --hostname 127.0.0.1)`,
  )
}
