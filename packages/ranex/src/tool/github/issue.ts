import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./issue.txt"
import { githubErrorResult } from "./shared"
import { GitHub } from "@/github/github"
import type { Result } from "@/github/issues"

const IssueOperation = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("list"),
    state: Schema.Literals(["open", "closed", "all"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("open" as const)),
    ),
    labels: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    milestone: Schema.optional(Schema.Number).annotate({ description: "Filter by milestone number." }),
  }),
  Schema.Struct({
    action: Schema.Literal("get"),
    number: Schema.Number,
  }),
  Schema.Struct({
    action: Schema.Literal("create"),
    title: Schema.String,
    body: Schema.optional(Schema.String),
    labels: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    assignees: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    milestone: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    number: Schema.Number,
    title: Schema.optional(Schema.String),
    body: Schema.optional(Schema.String),
    state: Schema.optional(Schema.Literals(["open", "closed"])),
  }),
  Schema.Struct({
    action: Schema.Literal("close"),
    number: Schema.Number,
  }),
  Schema.Struct({
    action: Schema.Literal("comment"),
    number: Schema.Number,
    body: Schema.String,
  }),
])

export const Parameters = Schema.Struct({
  owner: Schema.optional(Schema.String).annotate({
    description: "Repository owner. Defaults to the current git origin remote.",
  }),
  repo: Schema.optional(Schema.String).annotate({
    description: "Repository name. Defaults to the current git origin remote.",
  }),
  operation: IssueOperation.annotate({
    description: "The issue operation to perform.",
  }),
})

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

          const mode = WRITES.has(params.operation.action) ? "write" : "read"
          yield* ctx.ask({
            permission: "github",
            patterns: [`issues:${mode}:${owner}/${repo}`],
            always: [`issues:${mode}:${owner}/${repo}`],
            metadata: {
              action: params.operation.action,
              owner,
              repo,
            },
          })

          const result = yield* github.issue({ owner, repo }, params.operation)

          return {
            title: titleFor(
              result,
              owner,
              repo,
              params.operation.action === "comment" ? params.operation.number : undefined,
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

function titleFor(result: Result, owner: string, repo: string, commentNumber?: number) {
  if ("items" in result) return `${result.items.length} issues in ${owner}/${repo}`
  if (result.action === "comment") return `commented on #${commentNumber}`
  return result.item.title || `#${result.item.number}`
}
