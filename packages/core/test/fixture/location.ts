import { Location } from "@ranex/core/location"
import { makeLocationNode } from "@ranex/core/effect/app-node"
import { Git } from "@ranex/core/git"
import { Policy } from "@ranex/core/policy"
import { Project } from "@ranex/core/project"
import { ProjectResolution } from "@ranex/core/project-resolution"
import { LocationServiceMap } from "@ranex/core/location-service-map"
import type { LocationError, LocationServices } from "@ranex/core/location-services"
import { AbsolutePath } from "@ranex/core/schema"
import { Effect, Layer, LayerMap } from "effect"
import { tmpdir } from "./tmpdir"

export interface ProjectResolutionInput {
  readonly projectDirectory?: AbsolutePath
  readonly projectID?: Project.ID
  readonly vcs?: Project.Vcs
  readonly repository?: Git.Repository
}

export function location(ref: Location.Ref) {
  return {
    directory: ref.directory,
    workspaceID: ref.workspaceID,
  } satisfies Location.Interface
}

export function projectResolution(ref: Location.Ref, input: ProjectResolutionInput = {}) {
  const value = {
    project: {
      id: input.projectID ?? Project.ID.global,
      directory: input.projectDirectory ?? ref.directory,
      vcs: input.vcs,
      repository: input.repository,
    },
    repository: input.repository,
  }
  return ProjectResolution.Service.of({
    status: () => Effect.succeed({ status: "ready", value }),
    awaitReady: () => Effect.succeed(value),
  })
}

export function projectResolutionLayer(ref: Location.Ref, input: ProjectResolutionInput = {}) {
  return Layer.succeed(ProjectResolution.Service, projectResolution(ref, input))
}

export const readyPolicyNode = makeLocationNode({
  service: Policy.Service,
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const policy = yield* Policy.Service
      yield* policy.load([])
    }),
  ).pipe(Layer.provideMerge(Policy.locationLayer)),
  deps: [Location.node],
})

export function projectResolutionServiceMapLayer(input: ProjectResolutionInput = {}) {
  return projectResolutionServiceMapWith((ref) => projectResolution(ref, input))
}

export function projectResolutionServiceMapWith(
  make: (ref: Location.Ref) => ProjectResolution.Interface,
) {
  return Layer.effect(
    LocationServiceMap.Service,
    LayerMap.make(
      (ref: Location.Ref) =>
        Layer.mergeAll(
          Layer.succeed(Location.Service, Location.Service.of(location(ref))),
          Layer.succeed(ProjectResolution.Service, ProjectResolution.Service.of(make(ref))),
        ),
      { idleTimeToLive: "1 minute" },
    ) as unknown as Effect.Effect<LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>>,
  )
}

export const tempLocationLayer = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.map((tmp) => {
      const ref = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      return Layer.succeed(Location.Service, Location.Service.of(location(ref)))
    }),
  ),
)
