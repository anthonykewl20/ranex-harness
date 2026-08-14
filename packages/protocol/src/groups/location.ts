import { Location } from "@ranex/schema/location"
import { Project } from "@ranex/schema/project"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const LocationQuery = Schema.Struct({
  location: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String),
      workspace: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "LocationQuery" })

export const locationQueryOpenApi = OpenApi.annotations({
  transform: (operation) => {
    const parameters = operation.parameters
    if (!Array.isArray(parameters)) return operation
    return {
      ...operation,
      parameters: parameters.map((parameter) =>
        parameter?.name === "location" && parameter?.in === "query"
          ? { ...parameter, style: "deepObject", explode: true }
          : parameter,
      ),
    }
  },
})

export const LocationResolution = Schema.Union([
  Schema.Struct({ status: Schema.Literal("loading") }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    project: Location.Info.fields.project,
    vcs: Project.Vcs.pipe(Schema.optional),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    error: Schema.Literals(["timed_out", "git_failed", "filesystem_failed"]),
  }),
]).annotate({ identifier: "LocationResolution" })

export const LocationGetResponse = Schema.Struct({
  directory: Location.Ref.fields.directory,
  workspaceID: Location.Ref.fields.workspaceID,
  resolution: LocationResolution,
}).annotate({ identifier: "LocationGetResponse" })

export const LocationGroup = HttpApiGroup.make("server.location").add(
  HttpApiEndpoint.get("location.get", "/api/location", {
    query: LocationQuery,
    success: LocationGetResponse,
  })
    .annotateMerge(locationQueryOpenApi)
    .annotateMerge(
      OpenApi.annotations({
        identifier: "v2.location.get",
        summary: "Get location",
        description: "Resolve the requested location or the server default location.",
      }),
    ),
)
