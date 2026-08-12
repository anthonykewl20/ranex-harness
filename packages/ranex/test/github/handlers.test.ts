import { describe, expect, test } from "bun:test"
import type { graphql } from "@octokit/graphql"
import type { Octokit } from "@octokit/rest"
import { Cause, Effect, Exit } from "effect"
import { ApiError, isRateLimited } from "../../src/github/error"

const Issues = await import("../../src/github/issues")
const Milestones = await import("../../src/github/milestones")
const Projects = await import("../../src/github/projects")

const repo = { owner: "acme", repo: "widgets" }

test("isRateLimited detects 429 status", () => {
  expect(isRateLimited(new ApiError({ message: "Too Many Requests", status: 429 }))).toBe(true)
})

test("isRateLimited detects 403 with rate limit message", () => {
  expect(isRateLimited(new ApiError({ message: "API rate limit exceeded", status: 403 }))).toBe(true)
})

test("isRateLimited rejects non-rate-limit errors", () => {
  expect(isRateLimited(new ApiError({ message: "Not Found", status: 404 }))).toBe(false)
  expect(isRateLimited(new ApiError({ message: "Forbidden", status: 403 }))).toBe(false)
})

const sampleIssue = {
  id: 12345,
  node_id: "I_kwDOABx123=",
  number: 42,
  title: "Fix login bug",
  state: "open",
  html_url: "https://github.com/acme/widgets/issues/42",
  body: "Login fails on Safari when cookies are blocked",
  labels: [{ name: "bug" }, { name: "urgent" }],
  assignees: [{ login: "alice" }, { login: "bob" }],
  milestone: { number: 5, title: "v2.0" },
  created_at: "2024-01-15T10:00:00Z",
  updated_at: "2024-01-16T12:00:00Z",
}

const sparseIssue = {
  id: 12346,
  number: 43,
  title: "No description",
  state: "open",
  html_url: "https://github.com/acme/widgets/issues/43",
  body: null,
  labels: [],
  assignees: null,
  milestone: null,
  created_at: "2024-01-15T10:00:00Z",
  updated_at: "2024-01-15T10:00:00Z",
}

const samplePR = {
  id: 12347,
  number: 44,
  title: "Fix login bug",
  state: "open",
  html_url: "https://github.com/acme/widgets/pull/44",
  body: "Fixes #42",
  labels: [],
  assignees: [],
  milestone: null,
  created_at: "2024-01-15T10:00:00Z",
  updated_at: "2024-01-15T10:00:00Z",
  pull_request: { url: "...", html_url: "...", diff_url: "...", patch_url: "..." },
}

const sampleMilestone = {
  id: 100,
  number: 5,
  title: "v2.0",
  state: "open",
  description: "Second major release",
  due_on: "2024-06-01T00:00:00Z",
  open_issues: 12,
  closed_issues: 8,
  html_url: "https://github.com/acme/widgets/milestone/5",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-15T00:00:00Z",
}

const sampleComment = {
  id: 999,
  body: "This is fixed in PR #44",
  html_url: "https://github.com/acme/widgets/issues/42#issuecomment-999",
  created_at: "2024-01-17T08:00:00Z",
  user: { login: "alice" },
}

function makeFakeOctokit(stubs: {
  paginate?: (...args: unknown[]) => Promise<unknown[]>
  issuesGet?: (params: unknown) => Promise<{ data: unknown }>
  issuesCreate?: (params: unknown) => Promise<{ data: unknown }>
  issuesUpdate?: (params: unknown) => Promise<{ data: unknown }>
  issuesCreateComment?: (params: unknown) => Promise<{ data: unknown }>
  getMilestone?: (params: unknown) => Promise<{ data: unknown }>
  createMilestone?: (params: unknown) => Promise<{ data: unknown }>
  updateMilestone?: (params: unknown) => Promise<{ data: unknown }>
}): Octokit {
  return {
    paginate: stubs.paginate ?? (async () => []),
    rest: {
      issues: {
        listForRepo: {},
        get: stubs.issuesGet ?? (async () => ({ data: {} })),
        create: stubs.issuesCreate ?? (async () => ({ data: {} })),
        update: stubs.issuesUpdate ?? (async () => ({ data: {} })),
        createComment: stubs.issuesCreateComment ?? (async () => ({ data: {} })),
        listMilestones: {},
        getMilestone: stubs.getMilestone ?? (async () => ({ data: {} })),
        createMilestone: stubs.createMilestone ?? (async () => ({ data: {} })),
        updateMilestone: stubs.updateMilestone ?? (async () => ({ data: {} })),
      },
      projects: {},
    },
  } as unknown as Octokit
}

describe("github issue handlers", () => {
  test("list normalizes object labels and filters pull requests", async () => {
    const calls: unknown[][] = []
    const octokit = makeFakeOctokit({
      paginate: async (...args) => {
        calls.push(args)
        return [sampleIssue, sparseIssue, samplePR]
      },
    })

    const result = await Effect.runPromise(Issues.handle(octokit, repo, { action: "list" }))

    if (result.action !== "list") throw new Error(`Expected list result, received ${result.action}`)
    expect(result.items).toHaveLength(2)
    expect(result.items[0]?.labels).toEqual(["bug", "urgent"])
    expect(calls[0]).toHaveLength(2)
    expect(calls[0]?.[1]).toEqual({ owner: "acme", repo: "widgets", state: "open" })
  })

  test("list omits null body and milestone and defaults null assignees", async () => {
    const octokit = makeFakeOctokit({ paginate: async () => [sparseIssue] })

    const result = await Effect.runPromise(Issues.handle(octokit, repo, { action: "list" }))

    if (result.action !== "list") throw new Error(`Expected list result, received ${result.action}`)
    expect(result.items[0]).not.toHaveProperty("body")
    expect(result.items[0]).not.toHaveProperty("milestone")
    expect(result.items[0]?.assignees).toEqual([])
  })

  test("list passes milestone filter to octokit", async () => {
    const calls: unknown[][] = []
    const octokit = makeFakeOctokit({
      paginate: async (...args) => {
        calls.push(args)
        return [sampleIssue]
      },
    })
    await Effect.runPromise(Issues.handle(octokit, repo, { action: "list", milestone: 5 }))
    expect(calls[0]?.[1]).toMatchObject({ milestone: 5 })
  })

  test("list preserves labels returned as plain strings", async () => {
    const octokit = makeFakeOctokit({
      paginate: async () => [{ ...sampleIssue, labels: ["bug", "enhancement"] }],
    })

    const result = await Effect.runPromise(Issues.handle(octokit, repo, { action: "list" }))

    if (result.action !== "list") throw new Error(`Expected list result, received ${result.action}`)
    expect(result.items[0]?.labels).toEqual(["bug", "enhancement"])
  })

  test("get normalizes every populated issue field", async () => {
    const octokit = makeFakeOctokit({ issuesGet: async () => ({ data: sampleIssue }) })

    const result = await Effect.runPromise(Issues.handle(octokit, repo, { action: "get", number: 42 }))

    if (result.action !== "get") throw new Error(`Expected get result, received ${result.action}`)
    expect(result.item).toEqual({
      number: 42,
      title: "Fix login bug",
      state: "open",
      url: "https://github.com/acme/widgets/issues/42",
      body: "Login fails on Safari when cookies are blocked",
      labels: ["bug", "urgent"],
      assignees: ["alice", "bob"],
      milestone: 5,
      created_at: "2024-01-15T10:00:00Z",
      updated_at: "2024-01-16T12:00:00Z",
    })
  })

  test("create forwards optional fields and normalizes the response", async () => {
    const calls: unknown[] = []
    const octokit = makeFakeOctokit({
      issuesCreate: async (params) => {
        calls.push(params)
        return { data: sampleIssue }
      },
    })

    const result = await Effect.runPromise(
      Issues.handle(octokit, repo, {
        action: "create",
        title: "Fix login bug",
        body: "Login fails on Safari when cookies are blocked",
        labels: ["bug", "urgent"],
        assignees: ["alice", "bob"],
        milestone: 5,
      }),
    )

    if (result.action !== "create") throw new Error(`Expected create result, received ${result.action}`)
    expect(calls[0]).toEqual({
      owner: "acme",
      repo: "widgets",
      title: "Fix login bug",
      body: "Login fails on Safari when cookies are blocked",
      labels: ["bug", "urgent"],
      assignees: ["alice", "bob"],
      milestone: 5,
    })
    expect(result.action).toBe("create")
    expect(result.item.number).toBe(42)
    expect(result.item.labels).toEqual(["bug", "urgent"])
  })

  test("close delegates to update with closed state", async () => {
    const calls: unknown[] = []
    const octokit = makeFakeOctokit({
      issuesUpdate: async (params) => {
        calls.push(params)
        return { data: { ...sampleIssue, state: "closed" } }
      },
    })

    const result = await Effect.runPromise(Issues.handle(octokit, repo, { action: "close", number: 42 }))

    if (result.action !== "close") throw new Error(`Expected close result, received ${result.action}`)
    expect(calls[0]).toEqual({ owner: "acme", repo: "widgets", issue_number: 42, state: "closed" })
    expect(result.action).toBe("close")
    expect(result.item.state).toBe("closed")
  })

  test("update forwards direct issue changes", async () => {
    const calls: unknown[] = []
    const octokit = makeFakeOctokit({
      issuesUpdate: async (params) => {
        calls.push(params)
        return { data: { ...sampleIssue, title: "Fixed", body: "Resolved" } }
      },
    })
    const result = await Effect.runPromise(
      Issues.handle(octokit, repo, { action: "update", number: 42, title: "Fixed", body: "Resolved" }),
    )
    expect(calls).toEqual([{ owner: "acme", repo: "widgets", issue_number: 42, title: "Fixed", body: "Resolved" }])
    expect(result).toMatchObject({ action: "update", item: { title: "Fixed", body: "Resolved" } })
  })

  test("comment forwards its body and normalizes the response", async () => {
    const calls: unknown[] = []
    const octokit = makeFakeOctokit({
      issuesCreateComment: async (params) => {
        calls.push(params)
        return { data: sampleComment }
      },
    })

    const result = await Effect.runPromise(
      Issues.handle(octokit, repo, { action: "comment", number: 42, body: "This is fixed in PR #44" }),
    )

    if (result.action !== "comment") throw new Error(`Expected comment result, received ${result.action}`)
    expect(calls[0]).toEqual({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      body: "This is fixed in PR #44",
    })
    expect(result.item).toEqual({
      id: 999,
      body: "This is fixed in PR #44",
      url: "https://github.com/acme/widgets/issues/42#issuecomment-999",
      created_at: "2024-01-17T08:00:00Z",
      author: "alice",
    })
  })

  test("converts API failures to ApiError", async () => {
    const octokit = makeFakeOctokit({
      issuesGet: async () => Promise.reject({ status: 404, message: "Not Found" }),
    })

    const exit = await Effect.runPromise(Effect.exit(Issues.handle(octokit, repo, { action: "get", number: 404 })))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(ApiError)
      expect(Cause.squash(exit.cause)).toMatchObject({ status: 404, message: "Not Found" })
    }
  })
})

describe("github milestone handlers", () => {
  test("list omits null description and due date", async () => {
    const octokit = makeFakeOctokit({
      paginate: async () => [{ ...sampleMilestone, description: null, due_on: null }],
    })

    const result = await Effect.runPromise(Milestones.handle(octokit, repo, { action: "list" }))

    if (result.action !== "list") throw new Error(`Expected list result, received ${result.action}`)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).not.toHaveProperty("description")
    expect(result.items[0]).not.toHaveProperty("due_on")
  })

  test("create forwards optional fields and normalizes the response", async () => {
    const calls: unknown[] = []
    const octokit = makeFakeOctokit({
      createMilestone: async (params) => {
        calls.push(params)
        return { data: sampleMilestone }
      },
    })

    const result = await Effect.runPromise(
      Milestones.handle(octokit, repo, {
        action: "create",
        title: "v2.0",
        description: "Second major release",
        due_on: "2024-06-01T00:00:00Z",
      }),
    )

    if (result.action !== "create") throw new Error(`Expected create result, received ${result.action}`)
    expect(calls[0]).toEqual({
      owner: "acme",
      repo: "widgets",
      title: "v2.0",
      description: "Second major release",
      due_on: "2024-06-01T00:00:00Z",
    })
    expect(result.action).toBe("create")
    expect(result.item).toEqual({
      number: 5,
      title: "v2.0",
      state: "open",
      description: "Second major release",
      due_on: "2024-06-01T00:00:00Z",
      open_issues: 12,
      closed_issues: 8,
      url: "https://github.com/acme/widgets/milestone/5",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-15T00:00:00Z",
    })
  })

  test("get forwards milestone number", async () => {
    const calls: unknown[] = []
    const result = await Effect.runPromise(
      Milestones.handle(
        makeFakeOctokit({ getMilestone: async (params) => (calls.push(params), { data: sampleMilestone }) }),
        repo,
        { action: "get", number: 5 },
      ),
    )
    expect(calls).toEqual([{ owner: "acme", repo: "widgets", milestone_number: 5 }])
    expect(result).toMatchObject({ action: "get", item: { number: 5 } })
  })

  test("update forwards milestone changes", async () => {
    const calls: unknown[] = []
    const result = await Effect.runPromise(
      Milestones.handle(
        makeFakeOctokit({ updateMilestone: async (params) => (calls.push(params), { data: sampleMilestone }) }),
        repo,
        { action: "update", number: 5, title: "v2.1", state: "open", due_on: "2024-07-01T00:00:00Z" },
      ),
    )
    expect(calls).toEqual([{
      owner: "acme",
      repo: "widgets",
      milestone_number: 5,
      title: "v2.1",
      state: "open",
      due_on: "2024-07-01T00:00:00Z",
    }])
    expect(result.action).toBe("update")
  })

  test("close delegates to updateMilestone with closed state", async () => {
    const calls: unknown[] = []
    const octokit = makeFakeOctokit({
      updateMilestone: async (params) => {
        calls.push(params)
        return { data: { ...sampleMilestone, state: "closed" } }
      },
    })

    const result = await Effect.runPromise(Milestones.handle(octokit, repo, { action: "close", number: 5 }))

    if (result.action !== "close") throw new Error(`Expected close result, received ${result.action}`)
    expect(calls[0]).toEqual({
      owner: "acme",
      repo: "widgets",
      milestone_number: 5,
      state: "closed",
    })
    expect(result.action).toBe("close")
    expect(result.item.state).toBe("closed")
  })
})

describe("github project handlers", () => {
  test("list falls back to user endpoint when org returns 404", async () => {
    const userCalls: unknown[] = []
    let orgCalled = false
    const octokit = {
      paginate: async (_endpoint: unknown, params: unknown) => {
        if (!orgCalled && params && typeof params === "object" && "org" in params) {
          orgCalled = true
          throw { status: 404, message: "Not Found" }
        }
        userCalls.push(params)
        return [
          {
            number: 1,
            title: "My Project",
            html_url: "https://github.com/users/me/projects/1",
          },
        ]
      },
      rest: { issues: {}, projects: { listForOrg: {}, listForUser: {} } },
    } as unknown as Octokit
    const graphqlClient = (async () => ({})) as unknown as typeof graphql

    const result = await Effect.runPromise(
      Projects.handle({ octokit, graphql: graphqlClient }, { action: "list", owner: "me" }),
    )

    if (result.action !== "list") throw new Error(`Expected list, got ${result.action}`)
    expect(orgCalled).toBe(true)
    expect(userCalls).toEqual([{ username: "me" }])
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.url).toBe("https://github.com/users/me/projects/1")
  })

  test("get falls back with string user_id and constructs user URL", async () => {
    const calls: unknown[] = []
    const octokit = {
      rest: { projects: {
        getForOrg: async () => Promise.reject({ status: 404, message: "Not Found" }),
        getForUser: async (params: unknown) => (calls.push(params), { data: { number: 7, title: "Roadmap" } }),
      } },
    } as unknown as Octokit
    const result = await Effect.runPromise(
      Projects.handle({ octokit, graphql: (async () => ({})) as unknown as typeof graphql }, { action: "get", owner: "me", number: 7 }),
    )
    expect(calls).toEqual([{ user_id: "me", project_number: 7 }])
    expect(result).toMatchObject({ action: "get", item: { url: "https://github.com/users/me/projects/7" } })
  })

  test("create resolves owner and forwards GraphQL variables", async () => {
    const calls: Array<{ query: string; variables: unknown }> = []
    const graphqlClient = (async (query: string, variables: unknown) => {
      calls.push({ query, variables })
      if (query.includes("organization")) return { organization: { id: "ORG" } }
      return { createProjectV2: { projectV2: { number: 7, title: "Roadmap", url: "https://github.com/orgs/acme/projects/7" } } }
    }) as unknown as typeof graphql
    const result = await Effect.runPromise(
      Projects.handle({ octokit: {} as Octokit, graphql: graphqlClient }, { action: "create", owner: "acme", title: "Roadmap" }),
    )
    expect(calls[0]?.variables).toEqual({ login: "acme" })
    expect(calls[1]?.variables).toEqual({ ownerId: "ORG", title: "Roadmap" })
    expect(result).toMatchObject({ action: "create", item: { number: 7, title: "Roadmap" } })
  })

  test("create propagates non-404 errors resolving an organization owner", async () => {
    const calls: string[] = []
    const graphqlClient = (async (query: string) => {
      calls.push(query)
      throw { status: 403, message: "Forbidden" }
    }) as unknown as typeof graphql

    const exit = await Effect.runPromise(
      Effect.exit(
        Projects.handle(
          { octokit: {} as Octokit, graphql: graphqlClient },
          { action: "create", owner: "acme", title: "Roadmap" },
        ),
      ),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("organization")
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({ status: 403, message: "Forbidden" })
    }
  })

  test("add_item falls back with string user_id", async () => {
    const calls: unknown[] = []
    const octokit = {
      rest: {
        issues: { get: async (params: unknown) => (calls.push(params), { data: { id: 123 } }) },
        projects: {
          addItemForOrg: async () => Promise.reject({ status: 404, message: "Not Found" }),
          addItemForUser: async (params: unknown) => (calls.push(params), { data: { node_id: "ITEM", content_type: "Issue", content: { title: "Bug", number: 42 } } }),
        },
      },
    } as unknown as Octokit
    const result = await Effect.runPromise(
      Projects.handle(
        { octokit, graphql: (async () => ({})) as unknown as typeof graphql },
        { action: "add_item", owner: "me", number: 7, content: { owner: "acme", repo: "app", number: 42 } },
      ),
    )
    expect(calls).toEqual([
      { owner: "acme", repo: "app", issue_number: 42 },
      { user_id: "me", project_number: 7, type: "Issue", id: 123 },
    ])
    expect(result).toMatchObject({ action: "add_item", item: { id: "ITEM", content_number: 42 } })
  })

  test("set_field uses user endpoints and forwards GraphQL field variables", async () => {
    const userCalls: unknown[] = []
    const graphqlCalls: unknown[] = []
    const notFound = () => Promise.reject({ status: 404, message: "Not Found" })
    const octokit = {
      rest: { projects: {
        getForOrg: notFound,
        getForUser: async (params: unknown) => (userCalls.push(params), { data: { node_id: "PROJECT" } }),
        listFieldsForOrg: notFound,
        listFieldsForUser: async (params: unknown) => (userCalls.push(params), { data: [{ name: "Status", node_id: "FIELD", data_type: "single_select", options: [{ id: "DONE", name: { raw: "Done" } }] }] }),
        listItemsForOrg: notFound,
        listItemsForUser: async (params: unknown) => (userCalls.push(params), { data: [{ node_id: "ITEM", content_type: "Issue", content: { number: 42, title: "Bug", repository: { full_name: "acme/app" } } }] }),
      } },
    } as unknown as Octokit
    const graphqlClient = (async (_query: string, variables: unknown) => (graphqlCalls.push(variables), {})) as unknown as typeof graphql
    const result = await Effect.runPromise(
      Projects.handle(
        { octokit, graphql: graphqlClient },
        { action: "set_field", owner: "me", number: 7, field_name: "Status", value: "Done", content: { owner: "acme", repo: "app", number: 42 } },
      ),
    )
    expect(userCalls).toEqual([
      { user_id: "me", project_number: 7 },
      { user_id: "me", project_number: 7 },
      { user_id: "me", project_number: 7 },
    ])
    expect(graphqlCalls).toEqual([{ projectId: "PROJECT", itemId: "ITEM", fieldId: "FIELD", value: { singleSelectOptionId: "DONE" } }])
    expect(result).toMatchObject({ action: "set_field", item: { field_name: "Status", field_value: "Done" } })
  })
})
