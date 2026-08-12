import { describe, expect, test } from "bun:test"
import type { graphql } from "@octokit/graphql"
import type { Octokit } from "@octokit/rest"
import { Cause, Effect, Exit } from "effect"
import { ApiError } from "../../src/github/error"

const Issues = await import("../../src/github/issues")
const Milestones = await import("../../src/github/milestones")
const Projects = await import("../../src/github/projects")

const repo = { owner: "acme", repo: "widgets" }

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

    const exit = await Effect.runPromise(
      Effect.exit(Issues.handle(octokit, repo, { action: "get", number: 404 })),
    )

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

  test("close delegates to updateMilestone with closed state", async () => {
    const calls: unknown[] = []
    const octokit = makeFakeOctokit({
      updateMilestone: async (params) => {
        calls.push(params)
        return { data: { ...sampleMilestone, state: "closed" } }
      },
    })

    const result = await Effect.runPromise(
      Milestones.handle(octokit, repo, { action: "close", number: 5 }),
    )

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
  })
})
