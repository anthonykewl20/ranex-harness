import type { Octokit } from "@octokit/rest"
import { Effect, Schema } from "effect"
import { ApiError, toApiError } from "./error"

export const MilestoneInfo = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  description: Schema.optional(Schema.String),
  due_on: Schema.optional(Schema.String),
  open_issues: Schema.Number,
  closed_issues: Schema.Number,
  url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
})
export type MilestoneInfo = Schema.Schema.Type<typeof MilestoneInfo>

export type Operation =
  | { action: "list"; state?: "open" | "closed" | "all" }
  | { action: "get"; number: number }
  | { action: "create"; title: string; description?: string; due_on?: string }
  | {
      action: "update"
      number: number
      title?: string
      description?: string
      state?: "open" | "closed"
      due_on?: string
    }
  | { action: "close"; number: number }

export type Result =
  | { action: "list"; items: MilestoneInfo[] }
  | { action: "get" | "create" | "update" | "close"; item: MilestoneInfo }

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
  }
}

function list(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  op: { state?: "open" | "closed" | "all" },
) {
  return Effect.gen(function* () {
    const items = yield* Effect.tryPromise({
      try: () =>
        octokit.paginate(octokit.rest.issues.listMilestones, {
          owner: repo.owner,
          repo: repo.repo,
          state: op.state ?? "open",
        }),
      catch: toApiError,
    })
    return { action: "list" as const, items: items.map(normalizeMilestone) }
  })
}

function get(octokit: Octokit, repo: { owner: string; repo: string }, op: { number: number }) {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        octokit.rest.issues.getMilestone({
          owner: repo.owner,
          repo: repo.repo,
          milestone_number: op.number,
        }),
      catch: toApiError,
    })
    return { action: "get" as const, item: normalizeMilestone(response.data) }
  })
}

function create(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  op: { title: string; description?: string; due_on?: string },
) {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        octokit.rest.issues.createMilestone({
          owner: repo.owner,
          repo: repo.repo,
          title: op.title,
          ...(op.description !== undefined ? { description: op.description } : {}),
          ...(op.due_on !== undefined ? { due_on: op.due_on } : {}),
        }),
      catch: toApiError,
    })
    return { action: "create" as const, item: normalizeMilestone(response.data) }
  })
}

function update(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  op: {
    number: number
    title?: string
    description?: string
    state?: "open" | "closed"
    due_on?: string
  },
) {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        octokit.rest.issues.updateMilestone({
          owner: repo.owner,
          repo: repo.repo,
          milestone_number: op.number,
          ...(op.title !== undefined ? { title: op.title } : {}),
          ...(op.description !== undefined ? { description: op.description } : {}),
          ...(op.due_on !== undefined ? { due_on: op.due_on } : {}),
          ...(op.state !== undefined ? { state: op.state } : {}),
        }),
      catch: toApiError,
    })
    return { action: "update" as const, item: normalizeMilestone(response.data) }
  })
}

function normalizeMilestone(data: {
  number: number
  title: string
  state: string
  description?: string | null
  due_on?: string | null
  open_issues: number
  closed_issues: number
  html_url: string
  created_at: string
  updated_at: string
}): MilestoneInfo {
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    ...(data.description ? { description: data.description } : {}),
    ...(data.due_on ? { due_on: data.due_on } : {}),
    open_issues: data.open_issues,
    closed_issues: data.closed_issues,
    url: data.html_url,
    created_at: data.created_at,
    updated_at: data.updated_at,
  }
}
