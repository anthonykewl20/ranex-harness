import type { Octokit } from "@octokit/rest"
import { Effect, Schema } from "effect"
import { ApiError, withRateLimitRetry } from "./error"

export const IssueInfo = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  url: Schema.String,
  body: Schema.optional(Schema.String),
  labels: Schema.mutable(Schema.Array(Schema.String)),
  assignees: Schema.mutable(Schema.Array(Schema.String)),
  milestone: Schema.optional(Schema.Number),
  created_at: Schema.String,
  updated_at: Schema.String,
})
export type IssueInfo = Schema.Schema.Type<typeof IssueInfo>

export const IssueCommentInfo = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
  url: Schema.String,
  created_at: Schema.String,
  author: Schema.String,
})
export type IssueCommentInfo = Schema.Schema.Type<typeof IssueCommentInfo>

export type Operation =
  | { action: "list"; state?: "open" | "closed" | "all"; labels?: string[]; milestone?: number }
  | { action: "get"; number: number }
  | {
      action: "create"
      title: string
      body?: string
      labels?: string[]
      assignees?: string[]
      milestone?: number
    }
  | { action: "update"; number: number; title?: string; body?: string; state?: "open" | "closed" }
  | { action: "close"; number: number }
  | { action: "comment"; number: number; body: string }

export type Result =
  | { action: "list"; items: IssueInfo[] }
  | { action: "get" | "create" | "update" | "close"; item: IssueInfo }
  | { action: "comment"; item: IssueCommentInfo }

export function handle(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  op: Operation,
): Effect.Effect<Result, ApiError> {
  switch (op.action) {
    case "list":
      return list(octokit, repo, op)
    case "get":
      return get(octokit, repo, op)
    case "create":
      return create(octokit, repo, op)
    case "update":
      return update(octokit, repo, op)
    case "close":
      return update(octokit, repo, { number: op.number, state: "closed" }).pipe(
        Effect.map((result) => ({ action: "close" as const, item: result.item })),
      )
    case "comment":
      return createComment(octokit, repo, op)
  }
}

function list(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  op: { state?: "open" | "closed" | "all"; labels?: string[]; milestone?: number },
) {
  return Effect.gen(function* () {
    const items = yield* withRateLimitRetry(() =>
      octokit.paginate(octokit.rest.issues.listForRepo, {
        owner: repo.owner,
        repo: repo.repo,
        state: op.state ?? "open",
        ...(op.labels ? { labels: op.labels.join(",") } : {}),
        ...(op.milestone !== undefined ? { milestone: op.milestone as unknown as string } : {}),
      }),
    )
    return { action: "list" as const, items: items.filter(isIssue).map(normalizeIssue) }
  })
}

function get(octokit: Octokit, repo: { owner: string; repo: string }, op: { number: number }) {
  return Effect.gen(function* () {
    const response = yield* withRateLimitRetry(() =>
      octokit.rest.issues.get({ owner: repo.owner, repo: repo.repo, issue_number: op.number }),
    )
    return { action: "get" as const, item: normalizeIssue(response.data) }
  })
}

function create(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  op: {
    title: string
    body?: string
    labels?: string[]
    assignees?: string[]
    milestone?: number
  },
) {
  return Effect.gen(function* () {
    const response = yield* withRateLimitRetry(() =>
      octokit.rest.issues.create({
        owner: repo.owner,
        repo: repo.repo,
        title: op.title,
        ...(op.body !== undefined ? { body: op.body } : {}),
        ...(op.labels ? { labels: op.labels } : {}),
        ...(op.assignees ? { assignees: op.assignees } : {}),
        ...(op.milestone !== undefined ? { milestone: op.milestone } : {}),
      }),
    )
    return { action: "create" as const, item: normalizeIssue(response.data) }
  })
}

function update(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  op: { number: number; title?: string; body?: string; state?: "open" | "closed" },
) {
  return Effect.gen(function* () {
    const response = yield* withRateLimitRetry(() =>
      octokit.rest.issues.update({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: op.number,
        ...(op.title !== undefined ? { title: op.title } : {}),
        ...(op.body !== undefined ? { body: op.body } : {}),
        ...(op.state !== undefined ? { state: op.state } : {}),
      }),
    )
    return { action: "update" as const, item: normalizeIssue(response.data) }
  })
}

function createComment(octokit: Octokit, repo: { owner: string; repo: string }, op: { number: number; body: string }) {
  return Effect.gen(function* () {
    const response = yield* withRateLimitRetry(() =>
      octokit.rest.issues.createComment({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: op.number,
        body: op.body,
      }),
    )
    return {
      action: "comment" as const,
      item: {
        id: response.data.id,
        body: response.data.body ?? op.body,
        url: response.data.html_url,
        created_at: response.data.created_at,
        author: response.data.user?.login ?? "unknown",
      },
    }
  })
}

function normalizeIssue(data: {
  number: number
  title: string
  state: string
  html_url: string
  body?: string | null
  labels: Array<string | { name?: string | null }>
  assignees?: Array<{ login: string }> | null
  milestone: { number: number } | null
  created_at: string
  updated_at: string
}): IssueInfo {
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    url: data.html_url,
    ...(data.body ? { body: data.body } : {}),
    labels: data.labels
      .map((label) => (typeof label === "string" ? label : label.name))
      .filter((label): label is string => typeof label === "string"),
    assignees: (data.assignees ?? []).map((assignee) => assignee.login),
    ...(data.milestone ? { milestone: data.milestone.number } : {}),
    created_at: data.created_at,
    updated_at: data.updated_at,
  }
}

function isIssue<T extends { pull_request?: unknown }>(data: T): data is T & { pull_request?: undefined } {
  return data.pull_request === undefined || data.pull_request === null
}
