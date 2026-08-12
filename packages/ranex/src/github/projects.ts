import type { graphql } from "@octokit/graphql"
import type { Octokit } from "@octokit/rest"
import { Effect, Schema } from "effect"
import { ApiError, toApiError } from "./error"

export const ProjectInfo = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
})
export type ProjectInfo = Schema.Schema.Type<typeof ProjectInfo>

export const ProjectItemInfo = Schema.Struct({
  id: Schema.String,
  content_type: Schema.optional(Schema.String),
  content_title: Schema.optional(Schema.String),
  content_number: Schema.optional(Schema.Number),
  field_name: Schema.optional(Schema.String),
  field_value: Schema.optional(Schema.String),
})
export type ProjectItemInfo = Schema.Schema.Type<typeof ProjectItemInfo>

export type Operation =
  | { action: "list"; owner: string }
  | { action: "get"; owner: string; number: number }
  | { action: "create"; owner: string; title: string }
  | {
      action: "add_item"
      owner: string
      number: number
      content: { owner: string; repo: string; number: number }
    }
  | {
      action: "set_field"
      owner: string
      number: number
      field_name: string
      value: string
      content: { owner: string; repo: string; number: number }
    }

export type Result =
  | { action: "list"; items: ProjectInfo[] }
  | { action: "get"; item: ProjectInfo }
  | { action: "create"; item: ProjectInfo }
  | { action: "add_item"; item: ProjectItemInfo }
  | { action: "set_field"; item: ProjectItemInfo }

type Clients = { octokit: Octokit; graphql: typeof graphql }

export function handle(clients: Clients, op: Operation): Effect.Effect<Result, ApiError> {
  switch (op.action) {
    case "list":
      return list(clients, op)
    case "get":
      return get(clients, op)
    case "create":
      return create(clients, op)
    case "add_item":
      return addItem(clients, op)
    case "set_field":
      return setField(clients, op)
  }
}

function list(clients: Clients, op: { owner: string }) {
  return Effect.gen(function* () {
    const items = yield* withUserFallback(
      Effect.tryPromise({
        try: () => clients.octokit.paginate(clients.octokit.rest.projects.listForOrg, { org: op.owner }),
        catch: toApiError,
      }),
      () =>
        Effect.tryPromise({
          try: () =>
            clients.octokit.paginate(clients.octokit.rest.projects.listForUser, {
              username: op.owner,
            }),
          catch: toApiError,
        }),
    )
    return { action: "list" as const, items: items.map(normalizeProject) }
  })
}

function get(clients: Clients, op: { owner: string; number: number }) {
  return Effect.gen(function* () {
    const response = yield* withUserFallback(
      Effect.tryPromise({
        try: () =>
          clients.octokit.rest.projects.getForOrg({ org: op.owner, project_number: op.number }),
        catch: toApiError,
      }),
      () =>
        Effect.tryPromise({
          try: () =>
            clients.octokit.rest.projects.getForUser({
              // GitHub accepts username string in user_id path parameter
              user_id: op.owner as unknown as number,
              project_number: op.number,
            } as never),
          catch: toApiError,
        }),
    )
    return { action: "get" as const, item: normalizeProject(response.data) }
  })
}

function create(clients: Clients, op: { owner: string; title: string }) {
  return Effect.gen(function* () {
    const ownerId = yield* resolveOwnerId(clients, op.owner)
    const result = yield* Effect.tryPromise({
      try: () =>
        clients.graphql(
          `mutation($ownerId: ID!, $title: String!) {
            createProjectV2(input: { ownerId: $ownerId, title: $title }) {
              projectV2 { number title url }
            }
          }`,
          { ownerId, title: op.title },
        ),
      catch: toApiError,
    })
    const project = (
      result as { createProjectV2: { projectV2: { number: number; title: string; url: string } } }
    ).createProjectV2.projectV2
    return {
      action: "create" as const,
      item: { number: project.number, title: project.title, url: project.url },
    }
  })
}

function resolveOwnerId(clients: Clients, login: string): Effect.Effect<string, ApiError> {
  return Effect.gen(function* () {
    const orgResult = yield* Effect.tryPromise({
      try: () =>
        clients.graphql(`query($login: String!) { organization(login: $login) { id } }`, { login }),
      catch: toApiError,
    }).pipe(Effect.catch(() => Effect.succeed(null)))
    const orgId = (orgResult as { organization: { id: string } | null } | null)?.organization?.id
    if (orgId) return orgId

    const userResult = yield* Effect.tryPromise({
      try: () => clients.graphql(`query($login: String!) { user(login: $login) { id } }`, { login }),
      catch: toApiError,
    })
    const userId = (userResult as { user: { id: string } | null }).user?.id
    if (!userId) return yield* new ApiError({ message: `Could not resolve owner ID for "${login}"` })
    return userId
  })
}

function addItem(
  clients: Clients,
  op: {
    owner: string
    number: number
    content: { owner: string; repo: string; number: number }
  },
) {
  return Effect.gen(function* () {
    const issue = yield* Effect.tryPromise({
      try: () =>
        clients.octokit.rest.issues.get({
          owner: op.content.owner,
          repo: op.content.repo,
          issue_number: op.content.number,
        }),
      catch: toApiError,
    })
    const response = yield* withUserFallback(
      Effect.tryPromise({
        try: () =>
          clients.octokit.rest.projects.addItemForOrg({
            org: op.owner,
            project_number: op.number,
            type: "Issue",
            id: issue.data.id,
          }),
        catch: toApiError,
      }),
      () =>
        Effect.tryPromise({
          try: () =>
            clients.octokit.rest.projects.addItemForUser({
              // GitHub accepts username string in user_id path parameter
              user_id: op.owner as unknown as number,
              project_number: op.number,
              type: "Issue",
              id: issue.data.id,
            } as never),
          catch: toApiError,
        }),
    )
    return { action: "add_item" as const, item: yield* normalizeItem(response.data) }
  })
}

function setField(
  clients: Clients,
  op: {
    owner: string
    number: number
    field_name: string
    value: string
    content: { owner: string; repo: string; number: number }
  },
) {
  return Effect.gen(function* () {
    const project = yield* withUserFallback(
      Effect.tryPromise({
        try: () =>
          clients.octokit.rest.projects.getForOrg({ org: op.owner, project_number: op.number }),
        catch: toApiError,
      }),
      () =>
        Effect.tryPromise({
          try: () =>
            clients.octokit.rest.projects.getForUser({
              // GitHub accepts username string in user_id path parameter
              user_id: op.owner as unknown as number,
              project_number: op.number,
            } as never),
          catch: toApiError,
        }),
    )
    const fieldsResponse = yield* withUserFallback(
      Effect.tryPromise({
        try: () =>
          clients.octokit.rest.projects.listFieldsForOrg({ org: op.owner, project_number: op.number }),
        catch: toApiError,
      }),
      () =>
        Effect.tryPromise({
          try: () =>
            clients.octokit.rest.projects.listFieldsForUser({
              // GitHub accepts username string in user_id path parameter
              user_id: op.owner as unknown as number,
              project_number: op.number,
            } as never),
          catch: toApiError,
        }),
    )
    const field = fieldsResponse.data.find((item) => item.name === op.field_name)
    if (!field) {
      return yield* new ApiError({
        message: `Field "${op.field_name}" not found in project ${op.owner}/${op.number}`,
      })
    }
    if (!field.node_id) {
      return yield* new ApiError({ message: `Field "${op.field_name}" does not have a node ID` })
    }
    const fieldValue = buildFieldValue(field, op.value)
    if (!fieldValue) {
      return yield* new ApiError({ message: `Cannot set value for field type "${field.data_type}"` })
    }

    const itemsResponse = yield* withUserFallback(
      Effect.tryPromise({
        try: () =>
          clients.octokit.rest.projects.listItemsForOrg({ org: op.owner, project_number: op.number }),
        catch: toApiError,
      }),
      () =>
        Effect.tryPromise({
          try: () =>
            clients.octokit.rest.projects.listItemsForUser({
              // GitHub accepts username string in user_id path parameter
              user_id: op.owner as unknown as number,
              project_number: op.number,
            } as never),
          catch: toApiError,
        }),
    )
    const item = itemsResponse.data.find((candidate) => {
      const content = candidate.content as
        | { number?: number; repository?: { full_name?: string }; title?: string }
        | null
        | undefined
      return (
        content?.number === op.content.number &&
        content.repository?.full_name === `${op.content.owner}/${op.content.repo}`
      )
    })
    if (!item) {
      return yield* new ApiError({
        message: `Issue ${op.content.owner}/${op.content.repo}#${op.content.number} not found in project ${op.owner}/${op.number}`,
      })
    }
    if (!item.node_id) return yield* new ApiError({ message: "Project item does not have a node ID" })

    yield* Effect.tryPromise({
      try: () =>
        clients.graphql(
          `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
            updateProjectV2ItemFieldValue(input: {
              projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value
            }) { projectV2Item { id } }
          }`,
          {
            projectId: project.data.node_id,
            itemId: item.node_id,
            fieldId: field.node_id,
            value: fieldValue,
          },
        ),
      catch: toApiError,
    })

    const content = item.content as { title?: string; number?: number } | null | undefined
    return {
      action: "set_field" as const,
      item: {
        id: item.node_id,
        content_type: item.content_type,
        ...(content?.title ? { content_title: content.title } : {}),
        ...(content?.number ? { content_number: content.number } : {}),
        field_name: op.field_name,
        field_value: op.value,
      },
    }
  })
}

function buildFieldValue(
  field: {
    data_type: string
    options?: Array<{ id: string; name: { raw: string } }>
  },
  value: string,
): Record<string, unknown> | null {
  if (field.data_type === "single_select") {
    const option = field.options?.find((item) => item.name.raw === value)
    if (!option) return null
    return { singleSelectOptionId: option.id }
  }
  if (field.data_type === "text") return { text: value }
  if (field.data_type === "number") {
    const num = Number(value)
    return Number.isNaN(num) ? null : { number: num }
  }
  if (field.data_type === "date") {
    return Number.isNaN(Date.parse(value)) ? null : { date: value }
  }
  return null
}

function withUserFallback<A>(
  orgCall: Effect.Effect<A, ApiError>,
  makeUserCall: () => Effect.Effect<A, ApiError>,
): Effect.Effect<A, ApiError> {
  return orgCall.pipe(
    Effect.catch((error) => {
      if (error.status === 404) return makeUserCall()
      return Effect.fail(error)
    }),
  )
}

function normalizeProject(data: {
  number: number
  title: string
  html_url?: string
  url?: string
}): ProjectInfo {
  return { number: data.number, title: data.title, url: data.html_url ?? data.url ?? "" }
}

function normalizeItem(data: {
  node_id?: string
  content_type?: string
  content?: { title?: string; number?: number } | null
}): Effect.Effect<ProjectItemInfo, ApiError> {
  if (!data.node_id) return new ApiError({ message: "Project item does not have a node ID" })
  return Effect.succeed({
    id: data.node_id,
    ...(data.content_type ? { content_type: data.content_type } : {}),
    ...(data.content?.title ? { content_title: data.content.title } : {}),
    ...(data.content?.number ? { content_number: data.content.number } : {}),
  })
}
