import { expect, test } from "bun:test"
import { makeRestClient } from "../../src/github/github"

test("REST requests use the supported GitHub API version", async () => {
  const octokit = makeRestClient("test-token")
  const response = await octokit.request("GET /octocat", {
    request: {
      fetch: (_url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("X-GitHub-Api-Version")).toBe("2026-03-10")
        return Promise.resolve(new Response("octocat", { status: 200 }))
      },
    },
  })

  expect(response.data).toBe("octocat")
})
