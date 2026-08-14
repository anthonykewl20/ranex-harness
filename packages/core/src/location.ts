import { Context, Layer } from "effect"
import { Info, Ref, response } from "@ranex/schema/location"
import { LayerNode } from "./effect/layer-node"
import { makeLocationNode, tags } from "./effect/app-node"

export * as Location from "./location"

export { Info, Ref, response }

export interface Interface {
  readonly directory: Ref["directory"]
  readonly workspaceID?: Ref["workspaceID"]
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Location") {}

export const node = LayerNode.unbound(Service, tags.values.location)

const layer = (ref: Ref) =>
  Layer.succeed(
    Service,
    Service.of({
      directory: ref.directory,
      workspaceID: ref.workspaceID,
    }),
  )

export const boundNode = (ref: Ref) =>
  makeLocationNode({
    service: Service,
    layer: layer(ref),
    deps: [],
  })
