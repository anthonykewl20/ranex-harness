import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import DESCRIPTION from "./project.txt"
import { githubErrorResult, PositiveIdentifier } from "./shared"
import { GitHub } from "@/github/github"
import type { Result } from "@/github/projects"

const ContentRef = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  number: PositiveIdentifier,
})

export const Parameters = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("list"),
    owner: Schema.String.annotate({ description: "Org or user login that owns the projects." }),
  }),
  Schema.Struct({
    action: Schema.Literal("get"),
    owner: Schema.String,
    number: PositiveIdentifier.annotate({ description: "Project number." }),
  }),
  Schema.Struct({
    action: Schema.Literal("create"),
    owner: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("add_item"),
    owner: Schema.String,
    number: PositiveIdentifier.annotate({ description: "Project number." }),
    content: ContentRef.annotate({
      description: "The issue to add: { owner, repo, number }.",
    }),
  }),
  Schema.Struct({
    action: Schema.Literal("set_field"),
    owner: Schema.String,
    number: PositiveIdentifier.annotate({ description: "Project number." }),
    field_name: Schema.String,
    value: Schema.String,
    content: ContentRef.annotate({
      description: "The issue whose project item to update: { owner, repo, number }.",
    }),
  }),
])

type Metadata = {
  owner: string
  action: string
  number?: number
  count?: number
  url?: string
  field_name?: string
  field_value?: string
  content_number?: number
}

const WRITES = new Set(["create", "add_item", "set_field"])

export const GitHubProjectTool = Tool.define<typeof Parameters, Metadata, GitHub.Service>(
  "github_project",
  Effect.gen(function* () {
    const github = yield* GitHub.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const op = params
          const mode = WRITES.has(op.action) ? "write" : "read"
          yield* ctx.ask({
            permission: "github",
            patterns: [`projects:${mode}:${op.owner}`],
            always: [`projects:${mode}:${op.owner}`],
            metadata: {
              action: op.action,
              owner: op.owner,
              ...("number" in op ? { number: op.number } : {}),
            },
          })

          const result = yield* github.project(op)

          return {
            title: titleFor(result),
            output: JSON.stringify("items" in result ? result.items : result.item, null, 2),
            metadata: {
              owner: op.owner,
              action: result.action,
              ...("items" in result ? { count: result.items.length } : {}),
              ...("item" in result
                ? {
                    ...("number" in op ? { number: op.number } : {}),
                    ...("url" in result.item && result.item.url ? { url: result.item.url } : {}),
                    ...("field_name" in result.item ? { field_name: result.item.field_name } : {}),
                    ...("field_value" in result.item ? { field_value: result.item.field_value } : {}),
                    ...("content_number" in result.item
                      ? { content_number: result.item.content_number }
                      : {}),
                  }
                : {}),
            },
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              ...githubErrorResult(error),
              metadata: { owner: "", action: "error" } as Metadata,
            }),
          ),
        ),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

function titleFor(result: Result) {
  if ("items" in result) return `${result.items.length} projects`
  if (result.action === "add_item") {
    const item = result.item
    return `added ${item.content_type ?? "item"}${item.content_number ? ` #${item.content_number}` : ""}`
  }
  if (result.action === "set_field") {
    const item = result.item
    return `${item.field_name ?? "field"} → ${item.field_value ?? "value"}`
  }
  return result.item.title
}
