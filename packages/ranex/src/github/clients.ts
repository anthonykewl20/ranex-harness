import { graphql } from "@octokit/graphql"
import { Octokit } from "@octokit/rest"

export const GHES_V3_SUFFIX_REGEX = /\/api\/v3\/?$/

export function hostToRestUrl(host: string): string {
  if (host.toLowerCase() === "github.com") return process.env.GITHUB_API_URL || "https://api.github.com"
  return `https://${host}/api/v3`
}

export function hostToGraphqlUrl(host: string): string {
  if (process.env.GITHUB_GRAPHQL_URL) return process.env.GITHUB_GRAPHQL_URL
  const restUrl = hostToRestUrl(host)
  if (host.toLowerCase() === "github.com" && restUrl === "https://api.github.com") {
    return "https://api.github.com/graphql"
  }
  return restUrl.replace(GHES_V3_SUFFIX_REGEX, "/api/graphql")
}

export function makeRestClient(token: string, opts?: { host?: string; baseUrl?: string }): Octokit {
  const baseUrl = opts?.baseUrl ?? hostToRestUrl(opts?.host ?? "github.com")
  const octokit = new Octokit({ auth: token, baseUrl })
  octokit.hook.before("request", (options) => {
    options.headers["X-GitHub-Api-Version"] = "2026-03-10"
  })
  return octokit
}

export function makeGraphqlClient(
  token: string,
  opts?: { host?: string; baseUrl?: string },
): ReturnType<typeof graphql.defaults> {
  const baseUrl = opts?.baseUrl ?? hostToGraphqlUrl(opts?.host ?? "github.com")
  return graphql.defaults({ baseUrl, url: baseUrl, headers: { authorization: `token ${token}` } })
}

export * as Clients from "./clients"
