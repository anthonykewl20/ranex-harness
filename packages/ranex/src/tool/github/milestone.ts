import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./milestone.txt"
import { githubErrorResult, PositiveIdentifier } from "./shared"
import { GitHub } from "@/github/github"
import type { Operation, Result } from "@/github/milestones"

const Repository = {
  owner: Schema.optional(Schema.String).annotate({
    description: "Repository owner. Defaults to the current git origin remote.",
  }),
  repo: Schema.optional(Schema.String).annotate({
    description: "Repository name. Defaults to the current git origin remote.",
  }),
}

const DueOn = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
).annotate({ description: "An ISO 8601 timestamp with a UTC or numeric timezone." })

export const Parameters = Schema.Union([
  Schema.Struct({
    ...Repository,
    action: Schema.Literal("list"),
    state: Schema.Literals(["open", "closed", "all"]).pipe(
      Schema.withDecodingDefault(Effect.succeed("open" as const)),
    ),
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
    description: Schema.optional(Schema.String),
    due_on: Schema.optional(DueOn),
  }),
  Schema.Struct({
    ...Repository,
    action: Schema.Literal("update"),
    number: PositiveIdentifier,
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    state: Schema.optional(Schema.Literals(["open", "closed"])),
    due_on: Schema.optional(DueOn),
  }),
  Schema.Struct({
    ...Repository,
    action: Schema.Literal("close"),
    number: PositiveIdentifier,
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

const WRITES = new Set(["create", "update", "close"])

export const GitHubMilestoneTool = Tool.define<typeof Parameters, Metadata, GitHub.Service>(
  "github_milestone",
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
            patterns: [`milestones:${mode}:${owner}/${repo}`],
            always: [`milestones:${mode}:${owner}/${repo}`],
            metadata: {
              action: params.action,
              owner,
              repo,
            },
          })

          const result = yield* github.milestone({ owner, repo }, milestoneOperation(params))

          return {
            title: titleFor(result, owner, repo),
            output: JSON.stringify("items" in result ? result.items : result.item, null, 2),
            metadata: {
              owner,
              repo,
              action: result.action,
              ...("items" in result ? { count: result.items.length } : {}),
              ...("item" in result && "url" in result.item
                ? { url: result.item.url, number: result.item.number }
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

function titleFor(result: Result, owner: string, repo: string) {
  if ("items" in result) return `${result.items.length} milestones in ${owner}/${repo}`
  return result.item.title || `#${result.item.number}`
}

function milestoneOperation(params: typeof Parameters.Type): Operation {
  switch (params.action) {
    case "list":
      return { action: params.action, state: params.state }
    case "get":
    case "close":
      return { action: params.action, number: params.number }
    case "create":
      return { action: params.action, title: params.title, description: params.description, due_on: params.due_on }
    case "update":
      return {
        action: params.action,
        number: params.number,
        title: params.title,
        description: params.description,
        state: params.state,
        due_on: params.due_on,
      }
  }
}
