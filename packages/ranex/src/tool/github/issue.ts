import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./issue.txt"
import { githubErrorResult, PositiveIdentifier } from "./shared"
import { GitHub } from "@/github/github"
import type { Operation, Result } from "@/github/issues"

const Repository = {
  owner: Schema.optional(Schema.String).annotate({
    description: "Repository owner. Defaults to the current git origin remote.",
  }),
  repo: Schema.optional(Schema.String).annotate({
    description: "Repository name. Defaults to the current git origin remote.",
  }),
}

export const Parameters = Schema.Union([
  Schema.Struct({
    ...Repository,
    action: Schema.Literal("list"),
    state: Schema.Literals(["open", "closed", "all"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("open" as const)),
    ),
    labels: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    milestone: Schema.optional(PositiveIdentifier).annotate({ description: "Filter by milestone number." }),
  }),
  Schema.Struct({
    ...Repository,
    action: Schema.Literal("get"),
    number: PositiveIdentifier,
  }),
  Schema.Struct({
    ...Repository,
    action: Schema.Literal("create"),
    title: Schema.String,
    body: Schema.optional(Schema.String),
    labels: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    assignees: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    milestone: Schema.optional(PositiveIdentifier),
  }),
  Schema.Struct({
    ...Repository,
    action: Schema.Literal("update"),
    number: PositiveIdentifier,
    title: Schema.optional(Schema.String),
    body: Schema.optional(Schema.String),
    state: Schema.optional(Schema.Literals(["open", "closed"])),
  }),
  Schema.Struct({
    ...Repository,
    action: Schema.Literal("close"),
    number: PositiveIdentifier,
  }),
  Schema.Struct({
    ...Repository,
    action: Schema.Literal("comment"),
    number: PositiveIdentifier,
    body: Schema.String,
  }),
])

type Metadata = {
  owner: string
  repo: string
  action: string
  count?: number
  url?: string
  number?: number
}

const WRITES = new Set(["create", "update", "close", "comment"])

export const GitHubIssueTool = Tool.define<typeof Parameters, Metadata, GitHub.Service>(
  "github_issue",
  Effect.gen(function* () {
    const github = yield* GitHub.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const { owner, repo } = yield* github.resolveOwnerRepo({
            owner: params.owner,
            repo: params.repo,
          })

          const mode = WRITES.has(params.action) ? "write" : "read"
          yield* ctx.ask({
            permission: "github",
            patterns: [`issues:${mode}:${owner}/${repo}`],
            always: [`issues:${mode}:${owner}/${repo}`],
            metadata: {
              action: params.action,
              owner,
              repo,
            },
          })

          const result = yield* github.issue({ owner, repo }, issueOperation(params))

          return {
            title: titleFor(
              result,
              owner,
              repo,
              params.action === "comment" ? params.number : undefined,
            ),
            output: JSON.stringify("items" in result ? result.items : result.item, null, 2),
            metadata: {
              owner,
              repo,
              action: result.action,
              ...("items" in result ? { count: result.items.length } : {}),
              ...("item" in result && "url" in result.item
                ? {
                    url: result.item.url,
                    ...("number" in result.item ? { number: result.item.number } : {}),
                  }
                : {}),
            },
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ...githubErrorResult(error),
              metadata: { owner: "", repo: "", action: "error" } as Metadata,
            }),
          ),
        ),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

function issueOperation(params: typeof Parameters.Type): Operation {
  switch (params.action) {
    case "list":
      return { action: params.action, state: params.state, labels: params.labels, milestone: params.milestone }
    case "get":
    case "close":
      return { action: params.action, number: params.number }
    case "create":
      return {
        action: params.action,
        title: params.title,
        body: params.body,
        labels: params.labels,
        assignees: params.assignees,
        milestone: params.milestone,
      }
    case "update":
      return { action: params.action, number: params.number, title: params.title, body: params.body, state: params.state }
    case "comment":
      return { action: params.action, number: params.number, body: params.body }
  }
}

function titleFor(result: Result, owner: string, repo: string, commentNumber?: number) {
  if ("items" in result) return `${result.items.length} issues in ${owner}/${repo}`
  if (result.action === "comment") return `commented on #${commentNumber}`
  return result.item.title || `#${result.item.number}`
}
