import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Layer, Scope } from "effect"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Location } from "@ranex/core/location"
import { PermissionV2 } from "@ranex/core/permission"
import { AbsolutePath, RelativePath } from "@ranex/core/schema"
import { SessionV2 } from "@ranex/core/session"
import { GlobTool } from "@ranex/core/tool/glob"
import { ToolRegistry } from "@ranex/core/tool/registry"
import { ToolOutputStore } from "@ranex/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { toolIdentity, settleTool } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_glob_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let externalDirectory: string | undefined
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const layer = (directory: string) =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, GlobTool.node]), [
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ],
  ])

const testInLocation = <R, E2>(
  name: string,
  body: (directory: string) => Effect.Effect<void, unknown, R | Scope.Scope>,
  layerFor: (directory: string) => Layer.Layer<R, E2>,
) =>
  test(name, async () => {
    await using tmp = await tmpdir()
    assertions.length = 0
    externalDirectory = undefined
    await body(tmp.path).pipe(Effect.scoped, Effect.provide(layerFor(tmp.path)), Effect.runPromise)
  })

const glob = (registry: ToolRegistry.Interface, input: typeof GlobTool.Input.Type, id: string) =>
  settleTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id, name: "glob", input },
  })

describe("GlobTool location confinement", () => {
  testInLocation("finds files inside the active Location", (directory) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "a.txt"), "one"))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "b.md"), "two"))
      const registry = yield* ToolRegistry.Service

      const settled = yield* glob(registry, { pattern: "*.txt" }, "call-glob")
      expect(settled.result).toMatchObject({ type: "text" })
      expect(settled.output?.structured).toMatchObject([{ path: "a.txt", type: "file" }])
      expect(assertions).toMatchObject([{ sessionID, action: "glob", resources: ["*.txt"] }])
      expect(assertions.some((input) => input.action === "external_directory")).toBe(false)
    }),
    layer,
  )

  testInLocation("refuses relative paths escaping the Location", (directory) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "a.txt"), "one"))
      const registry = yield* ToolRegistry.Service

      expect((yield* glob(registry, { pattern: "*.txt", path: RelativePath.make("../..") }, "call-glob-escape")).result).toEqual({
        type: "error",
        value: "Unable to find files matching *.txt",
      })
      expect(assertions).toMatchObject([{ action: "glob", resources: ["*.txt"] }])
      expect(assertions.some((input) => input.action === "external_directory")).toBe(false)
    }),
    layer,
  )

  testInLocation("gates absolute external paths behind external_directory", (directory) =>
    Effect.gen(function* () {
      const external = yield* Effect.promise(() =>
        fs.mkdtemp(path.join(os.tmpdir(), "glob-tool-external-")).then((dir) =>
          fs.writeFile(path.join(dir, "outside.txt"), "x").then(() => dir),
        ),
      )
      externalDirectory = external
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(external, { recursive: true, force: true })))
      const registry = yield* ToolRegistry.Service

      const settled = yield* glob(registry, { pattern: "*.txt", path: RelativePath.make(external) }, "call-glob-external")
      expect(settled.result).toMatchObject({ type: "text" })
      expect(settled.output?.structured).toMatchObject([{ path: expect.stringContaining("outside.txt"), type: "file" }])
      expect(assertions).toMatchObject([
        { sessionID, action: "glob", resources: ["*.txt"] },
        {
          sessionID,
          action: "external_directory",
          resources: [path.join(externalDirectory!, "*")],
        },
      ])
    }),
    layer,
  )
})
