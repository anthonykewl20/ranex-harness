import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { ApiError, AuthMissing, RepoNotResolved } from "../../src/github/error"
import { GitHub } from "../../src/github/github"
import { MessageID, SessionID } from "../../src/session/schema"
import { GitHubIssueTool } from "../../src/tool/github/issue"
import { GitHubMilestoneTool } from "../../src/tool/github/milestone"
import { GitHubProjectTool } from "../../src/tool/github/project"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"

const issue = {
  number: 42,
  title: "Bug",
  state: "open",
  url: "https://github.com/acme/app/issues/42",
  labels: [],
  assignees: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
}
const milestone = {
  number: 3,
  title: "v2",
  state: "open",
  open_issues: 1,
  closed_issues: 0,
  url: "https://github.com/acme/app/milestone/3",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
}

function context(asks: unknown[]): Tool.Context {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (request) => Effect.sync(() => asks.push(request)),
  }
}

function layers(github: GitHub.Interface) {
  return Layer.mergeAll(
    Layer.succeed(GitHub.Service, GitHub.Service.of(github)),
    Layer.mock(Agent.Service, { get: () => Effect.succeed({} as Agent.Info) }),
    Layer.mock(Truncate.Service, {
      output: (output: string) => Effect.succeed({ content: output, truncated: false as const }),
    }),
  )
}

async function execute(
  infoEffect: typeof GitHubIssueTool | typeof GitHubMilestoneTool | typeof GitHubProjectTool,
  input: unknown,
  github: GitHub.Interface,
  asks: unknown[],
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const info = yield* infoEffect
      const tool = yield* info.init()
      const invoke = tool.execute as unknown as (input: unknown, ctx: Tool.Context) => Effect.Effect<Tool.ExecuteResult>
      return yield* invoke(input, context(asks))
    }).pipe(Effect.provide(layers(github))),
  )
}

describe("GitHub tools", () => {
  test.each([
    [{ action: "list" }, "read"],
    [{ action: "get", number: "42" }, "read"],
    [{ action: "create", title: "Bug" }, "write"],
    [{ action: "update", number: "42", title: "Fixed" }, "write"],
    [{ action: "close", number: "42" }, "write"],
    [{ action: "comment", number: "42", body: "Done" }, "write"],
  ] as const)("issue dispatches %s", async (input, mode) => {
    const calls: unknown[] = []
    const asks: unknown[] = []
    const result = await execute(
      GitHubIssueTool,
      input,
      GitHub.Service.of({
        resolveOwnerRepo: (placement) => Effect.sync(() => (calls.push(placement), { owner: "acme", repo: "app" })),
        issue: (placement, op) =>
          Effect.sync(() => {
            calls.push({ placement, op })
            if (op.action === "list") return { action: "list" as const, items: [issue] }
            if (op.action === "comment") {
              return { action: "comment" as const, item: { id: 1, body: op.body, url: `${issue.url}#comment`, created_at: issue.created_at, author: "me" } }
            }
            return { action: op.action, item: issue }
          }),
        milestone: () => Effect.die("unexpected"),
        project: () => Effect.die("unexpected"),
      }),
      asks,
    )
    expect(calls[0]).toEqual({ owner: undefined, repo: undefined })
    expect(calls[1]).toMatchObject({ placement: { owner: "acme", repo: "app" }, op: { action: input.action } })
    if ("number" in input) expect(calls[1]).toMatchObject({ op: { number: 42 } })
    expect(asks[0]).toMatchObject({ patterns: [`issues:${mode}:acme/app`], always: [`issues:${mode}:acme/app`] })
    expect(result.metadata).toMatchObject({ action: input.action, owner: "acme", repo: "app", truncated: false })
    expect(result.output).toContain(input.action === "comment" ? "Done" : input.action === "list" ? "Bug" : "42")
  })

  test.each([
    [
      {
        action: "create",
        title: "Rich issue",
        body: "Every create field",
        labels: ["bug", "urgent"],
        assignees: ["alice", "bob"],
        milestone: 7,
      },
      {
        action: "create",
        title: "Rich issue",
        body: "Every create field",
        labels: ["bug", "urgent"],
        assignees: ["alice", "bob"],
        milestone: 7,
      },
    ],
    [
      { action: "update", number: 42, title: "Updated issue", body: "Every update field", state: "closed" },
      { action: "update", number: 42, title: "Updated issue", body: "Every update field", state: "closed" },
    ],
  ] as const)("issue %s forwards its payload", async (input, expected) => {
    const calls: unknown[] = []
    await execute(
      GitHubIssueTool,
      input,
      GitHub.Service.of({
        resolveOwnerRepo: () => Effect.succeed({ owner: "acme", repo: "app" }),
        issue: (placement, op) => {
          calls.push({ placement, op })
          if (op.action !== "create" && op.action !== "update") return Effect.die("unexpected")
          return Effect.succeed({ action: op.action, item: issue })
        },
        milestone: () => Effect.die("unexpected"),
        project: () => Effect.die("unexpected"),
      }),
      [],
    )
    expect(calls[0]).toEqual({ placement: { owner: "acme", repo: "app" }, op: expected })
  })

  test.each([
    [{ action: "list", owner: "acme", repo: "app" }, "read"],
    [{ action: "get", owner: "acme", repo: "app", number: "3" }, "read"],
    [{ action: "create", owner: "acme", repo: "app", title: "v2" }, "write"],
    [{ action: "update", owner: "acme", repo: "app", number: "3", title: "v2.1" }, "write"],
    [{ action: "close", owner: "acme", repo: "app", number: "3" }, "write"],
  ] as const)("milestone dispatches %s", async (input, mode) => {
    const calls: unknown[] = []
    const asks: unknown[] = []
    const result = await execute(
      GitHubMilestoneTool,
      input,
      GitHub.Service.of({
        resolveOwnerRepo: (placement) => Effect.sync(() => (calls.push(placement), { owner: "acme", repo: "app" })),
        issue: () => Effect.die("unexpected"),
        milestone: (placement, op) =>
          Effect.sync(() => {
            calls.push({ placement, op })
            return op.action === "list" ? { action: "list" as const, items: [milestone] } : { action: op.action, item: milestone }
          }),
        project: () => Effect.die("unexpected"),
      }),
      asks,
    )
    expect(calls[0]).toEqual({ owner: "acme", repo: "app" })
    expect(calls[1]).toMatchObject({ placement: { owner: "acme", repo: "app" }, op: { action: input.action } })
    if ("number" in input) expect(calls[1]).toMatchObject({ op: { number: 3 } })
    expect(asks[0]).toMatchObject({ patterns: [`milestones:${mode}:acme/app`] })
    expect(result.title).toContain(input.action === "list" ? "milestones" : "v2")
    expect(result.metadata).toMatchObject({ action: input.action, truncated: false })
  })

  test.each([
    [
      { action: "create", owner: "acme", repo: "app", title: "v3", description: "Third release", due_on: "2026-09-01T00:00:00Z" },
      { action: "create", title: "v3", description: "Third release", due_on: "2026-09-01T00:00:00Z" },
    ],
    [
      { action: "update", owner: "acme", repo: "app", number: 3, title: "v3.1", description: "Updated release", due_on: "2026-10-01T00:00:00Z", state: "closed" },
      { action: "update", number: 3, title: "v3.1", description: "Updated release", due_on: "2026-10-01T00:00:00Z", state: "closed" },
    ],
  ] as const)("milestone %s forwards its payload", async (input, expected) => {
    const calls: unknown[] = []
    await execute(
      GitHubMilestoneTool,
      input,
      GitHub.Service.of({
        resolveOwnerRepo: () => Effect.succeed({ owner: "acme", repo: "app" }),
        issue: () => Effect.die("unexpected"),
        milestone: (placement, op) => {
          calls.push({ placement, op })
          if (op.action !== "create" && op.action !== "update") return Effect.die("unexpected")
          return Effect.succeed({ action: op.action, item: milestone })
        },
        project: () => Effect.die("unexpected"),
      }),
      [],
    )
    expect(calls[0]).toEqual({ placement: { owner: "acme", repo: "app" }, op: expected })
  })

  test.each([
    [{ action: "list", owner: "acme" }, "read"],
    [{ action: "get", owner: "acme", number: "7" }, "read"],
    [{ action: "create", owner: "acme", title: "Roadmap" }, "write"],
    [{ action: "add_item", owner: "acme", number: "7", content: { owner: "acme", repo: "app", number: "42" } }, "write"],
    [{ action: "set_field", owner: "acme", number: "7", field_name: "Status", value: "Done", content: { owner: "acme", repo: "app", number: "42" } }, "write"],
  ] as const)("project dispatches %s", async (input, mode) => {
    const calls: unknown[] = []
    const asks: unknown[] = []
    const result = await execute(
      GitHubProjectTool,
      input,
      GitHub.Service.of({
        resolveOwnerRepo: () => Effect.die("unexpected"),
        issue: () => Effect.die("unexpected"),
        milestone: () => Effect.die("unexpected"),
        project: (op) =>
          Effect.sync(() => {
            calls.push(op)
            if (op.action === "list") return { action: "list" as const, items: [{ number: 7, title: "Roadmap", url: "https://github.com/orgs/acme/projects/7" }] }
            if (op.action === "add_item") return { action: "add_item" as const, item: { id: "item", content_type: "Issue", content_number: 42 } }
            if (op.action === "set_field") return { action: "set_field" as const, item: { id: "item", field_name: op.field_name, field_value: op.value, content_number: 42 } }
            return { action: op.action, item: { number: 7, title: "Roadmap", url: "https://github.com/orgs/acme/projects/7" } }
          }),
      }),
      asks,
    )
    expect(calls[0]).toMatchObject({ action: input.action, owner: "acme" })
    if ("number" in input) expect(calls[0]).toMatchObject({ number: 7 })
    if ("content" in input) expect(calls[0]).toMatchObject({ content: { number: 42 } })
    expect(asks[0]).toMatchObject({ patterns: [`projects:${mode}:acme`] })
    expect(result.metadata).toMatchObject({ action: input.action, owner: "acme", truncated: false })
    expect(result.output).toContain(input.action === "set_field" ? "Status" : input.action === "add_item" ? "Issue" : "Roadmap")
  })

  test("maps GitHub service errors", async () => {
    const result = await execute(
      GitHubProjectTool,
      { action: "list", owner: "acme" },
      GitHub.Service.of({
        resolveOwnerRepo: () => Effect.die("unexpected"),
        issue: () => Effect.die("unexpected"),
        milestone: () => Effect.die("unexpected"),
        project: () => Effect.fail(new ApiError({ message: "Forbidden", status: 403 })),
      }),
      [],
    )
    expect(result).toMatchObject({ title: "GitHub API error (403)", output: "Forbidden", metadata: { action: "error" } })
  })

  test("maps missing GitHub auth", async () => {
    const result = await execute(
      GitHubProjectTool,
      { action: "list", owner: "acme" },
      GitHub.Service.of({
        resolveOwnerRepo: () => Effect.die("unexpected"),
        issue: () => Effect.die("unexpected"),
        milestone: () => Effect.die("unexpected"),
        project: () => Effect.fail(new AuthMissing({ message: "missing token" })),
      }),
      [],
    )
    expect(result).toMatchObject({
      title: "GitHub auth required",
      output: "GITHUB_TOKEN environment variable is not set. Set it to a GitHub personal access token with repo and project scope.",
    })
  })

  test("maps unresolved repositories", async () => {
    const result = await execute(
      GitHubIssueTool,
      { action: "list" },
      GitHub.Service.of({
        resolveOwnerRepo: () => Effect.fail(new RepoNotResolved({ message: "No GitHub remote found" })),
        issue: () => Effect.die("unexpected"),
        milestone: () => Effect.die("unexpected"),
        project: () => Effect.die("unexpected"),
      }),
      [],
    )
    expect(result).toMatchObject({ title: "Repository not resolved", output: "No GitHub remote found" })
  })
})
