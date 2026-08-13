import { Effect } from "effect"
import { parse } from "yaml"
import { AuthMissing } from "./error"

function normalizeHost(host: string) {
  return host
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

export function resolveHost(): string {
  return normalizeHost(process.env.GH_HOST || "github.com")
}

export function isEnterprise(host: string): boolean {
  return host.toLowerCase() !== "github.com"
}

export function ghConfigDir(): string {
  if (process.env.GH_CONFIG_DIR) return process.env.GH_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return `${process.env.XDG_CONFIG_HOME}/gh`
  return `${process.env.HOME}/.config/gh`
}

const readHostsToken = Effect.fnUntraced(function* (host: string) {
  return yield* Effect.promise(async () => {
    try {
      const file = Bun.file(`${ghConfigDir()}/hosts.yml`)
      if (!(await file.exists())) return null
      const document: unknown = parse(await file.text())
      if (
        typeof document !== "object" ||
        document === null ||
        !Object.prototype.hasOwnProperty.call(document, host)
      )
        return null
      const entry = (document as Record<string, unknown>)[host]
      if (typeof entry !== "object" || entry === null || !("oauth_token" in entry)) return null
      const token = (entry as Record<string, unknown>).oauth_token
      return typeof token === "string" && token.trim() ? token.trim() : null
    } catch {
      return null
    }
  })
})

export const resolveToken = Effect.fn("GitHub.auth.resolveToken")(function* (opts?: { host?: string }) {
  const host = opts?.host ? normalizeHost(opts.host) : resolveHost()
  const envToken = isEnterprise(host)
    ? process.env.GH_ENTERPRISE_TOKEN ||
      process.env.GITHUB_ENTERPRISE_TOKEN ||
      (process.env.CODESPACES === "true" ? process.env.GITHUB_TOKEN : undefined)
    : process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (envToken) return envToken

  const hostsToken = yield* readHostsToken(host)
  if (hostsToken) return hostsToken

  const home = process.env.HOME
  if (!isEnterprise(host) && home) {
    const fileToken = yield* Effect.promise(async () => {
      try {
        const file = Bun.file(`${home}/.config/opencode/github-token`)
        if (!(await file.exists())) return null
        return (await file.text()).trim() || null
      } catch {
        return null
      }
    })
    if (fileToken) return fileToken
  }

  const ghToken = yield* Effect.promise(async () => {
    try {
      const proc = Bun.spawn(["gh", "auth", "token", "--secure-storage", "--hostname", host], {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(3_000),
      })
      const exitCode = await proc.exited
      if (exitCode !== 0) return null
      return (await new Response(proc.stdout).text()).trim() || null
    } catch {
      return null
    }
  })
  if (ghToken) return ghToken

  return yield* new AuthMissing({
    message:
      `No GitHub token found for ${host}. Set the appropriate GitHub token env var, configure gh hosts.yml${isEnterprise(host) ? "" : ", write to ~/.config/opencode/github-token"}, or authenticate with \`gh auth login --hostname ${host}\`.`,
  })
})

export const resolveTokenOptional = Effect.fn("GitHub.auth.resolveTokenOptional")(function* (opts?: { host?: string }) {
  return yield* resolveToken(opts).pipe(Effect.catchTag("GitHub.AuthMissing", () => Effect.succeed(null)))
})

export * as Auth from "./auth"
