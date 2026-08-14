import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { Location } from "@ranex/core/location"
import { AbsolutePath } from "@ranex/core/schema"
import { WorkspaceV2 } from "@ranex/core/workspace"
import { testEffect } from "./lib/effect"

const workspaceID = WorkspaceV2.ID.make("wrk_test")
const ref = Location.Ref.make({ directory: AbsolutePath.make("/repo/packages/app"), workspaceID })
const it = testEffect(AppNodeBuilder.build(Location.boundNode(ref)))

describe("Location", () => {
  it.effect("synchronously exposes only binding identity", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service

      expect(location.directory).toBe(ref.directory)
      expect(location.workspaceID).toBe(workspaceID)
      expect(Object.keys(location).toSorted()).toEqual(["directory", "workspaceID"])
    }),
  )
})
