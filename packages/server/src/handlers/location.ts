import { Location } from "@ranex/core/location"
import { ProjectResolution } from "@ranex/core/project-resolution"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const LocationHandler = HttpApiBuilder.group(Api, "server.location", (handlers) =>
  handlers.handle(
    "location.get",
    Effect.fn(function* () {
      const location = yield* Location.Service
      const resolution = yield* ProjectResolution.Service
      const status = yield* resolution.status()
      return {
        directory: location.directory,
        workspaceID: location.workspaceID,
        resolution:
          status.status === "loading"
            ? { status: "loading" as const }
            : status.status === "failed"
              ? { status: "failed" as const, error: status.error._tag }
              : {
                  status: "ready" as const,
                  project: {
                    id: status.value.project.id,
                    directory: status.value.project.directory,
                  },
                  vcs: status.value.project.vcs?.type,
                },
      }
    }),
  ),
)
