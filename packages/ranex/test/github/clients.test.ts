import { afterEach, describe, expect, test } from "bun:test"
import {
  GHES_V3_SUFFIX_REGEX,
  hostToGraphqlUrl,
  hostToRestUrl,
  makeGraphqlClient,
  makeRestClient,
} from "../../src/github/clients"

const previousApiUrl = process.env.GITHUB_API_URL
const previousGraphqlUrl = process.env.GITHUB_GRAPHQL_URL

describe.serial("github.clients", () => {
  afterEach(() => {
    if (previousApiUrl === undefined) delete process.env.GITHUB_API_URL
    if (previousApiUrl !== undefined) process.env.GITHUB_API_URL = previousApiUrl
    if (previousGraphqlUrl === undefined) delete process.env.GITHUB_GRAPHQL_URL
    if (previousGraphqlUrl !== undefined) process.env.GITHUB_GRAPHQL_URL = previousGraphqlUrl
  })

  test("builds default github.com URLs", () => {
    delete process.env.GITHUB_API_URL
    delete process.env.GITHUB_GRAPHQL_URL
    expect(hostToRestUrl("github.com")).toBe("https://api.github.com")
    expect(hostToGraphqlUrl("github.com")).toBe("https://api.github.com/graphql")
  })

  test("honors GitHub URL environment overrides", () => {
    process.env.GITHUB_API_URL = "https://api.example.test/api/v3"
    process.env.GITHUB_GRAPHQL_URL = "https://graphql.example.test"
    expect(hostToRestUrl("github.com")).toBe("https://api.example.test/api/v3")
    expect(hostToGraphqlUrl("github.com")).toBe("https://graphql.example.test")
  })

  test("rewrites a GitHub REST override when GraphQL is not overridden", () => {
    process.env.GITHUB_API_URL = "https://api.example.test/api/v3"
    delete process.env.GITHUB_GRAPHQL_URL
    expect(hostToGraphqlUrl("github.com")).toBe("https://api.example.test/api/graphql")
  })

  test("builds and rewrites enterprise URLs", () => {
    delete process.env.GITHUB_GRAPHQL_URL
    expect(hostToRestUrl("ghe.example.com")).toBe("https://ghe.example.com/api/v3")
    expect(hostToGraphqlUrl("ghe.example.com")).toBe("https://ghe.example.com/api/graphql")
    expect("https://host/api/v3/".replace(GHES_V3_SUFFIX_REGEX, "/api/graphql")).toBe(
      "https://host/api/graphql",
    )
  })

  test("GraphQL environment override wins for enterprise hosts", () => {
    process.env.GITHUB_GRAPHQL_URL = "https://override.example.test/graphql"
    expect(hostToGraphqlUrl("ghe.example.com")).toBe("https://override.example.test/graphql")
  })

  test("REST client passes auth, base URL, and API version", async () => {
    const octokit = makeRestClient("rest-token", { baseUrl: "https://rest.example.test" })
    await octokit.request("GET /octocat", {
      request: {
        fetch: (url: string, init?: RequestInit) => {
          expect(url).toBe("https://rest.example.test/octocat")
          const headers = new Headers(init?.headers)
          expect(headers.get("authorization")).toBe("token rest-token")
          expect(headers.get("X-GitHub-Api-Version")).toBe("2026-03-10")
          return Promise.resolve(new Response("octocat", { status: 200 }))
        },
      },
    })
  })

  test("GraphQL client passes auth and base URL", async () => {
    const client = makeGraphqlClient("graphql-token", { baseUrl: "https://graphql.example.test/api/graphql" })
    await client("query { viewer { login } }", {
      request: {
        fetch: (url: string, init?: RequestInit) => {
          expect(url).toBe("https://graphql.example.test/api/graphql")
          expect(new Headers(init?.headers).get("authorization")).toBe("token graphql-token")
          return Promise.resolve(Response.json({ data: { viewer: { login: "test" } } }))
        },
      },
    })
  })
})
