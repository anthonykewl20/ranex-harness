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
import { GrepTool } from "@ranex/core/tool/grep"
import { ToolRegistry } from "@ranex/core/tool/registry"
import { ToolOutputStore } from "@ranex/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { toolIdentity, settleTool } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_grep_tool_test")
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
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, GrepTool.node]), [
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

const grep = (registry: ToolRegistry.Interface, input: typeof GrepTool.Input.Type, id: string) =>
  settleTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id, name: "grep", input },
  })

describe("GrepTool location confinement", () => {
  testInLocation("searches inside the active Location", (directory) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "notes.md"), "needle found here"))
      const registry = yield* ToolRegistry.Service

      const settled = yield* grep(registry, { pattern: "needle" }, "call-grep")
      expect(settled.result).toMatchObject({ type: "text" })
      expect(settled.output?.structured).toMatchObject([
        { entry: { path: "notes.md", type: "file" }, line: 1, text: "needle found here" },
      ])
      expect(assertions).toMatchObject([{ sessionID, action: "grep", resources: ["needle"] }])
      expect(assertions.some((input) => input.action === "external_directory")).toBe(false)
    }),
    layer,
  )

  testInLocation("refuses relative paths escaping the Location", (directory) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "notes.md"), "needle found here"))
      const registry = yield* ToolRegistry.Service

      expect((yield* grep(registry, { pattern: "needle", path: RelativePath.make("../..") }, "call-grep-escape")).result).toEqual({
        type: "error",
        value: "Unable to grep for needle",
      })
      expect(assertions).toMatchObject([{ action: "grep", resources: ["needle"] }])
      expect(assertions.some((input) => input.action === "external_directory")).toBe(false)
    }),
    layer,
  )

  testInLocation("gates absolute external paths behind external_directory", (directory) =>
    Effect.gen(function* () {
      const external = yield* Effect.promise(() =>
        fs.mkdtemp(path.join(os.tmpdir(), "grep-tool-external-")).then((dir) =>
          fs.writeFile(path.join(dir, "secret.txt"), "needle outside").then(() => dir),
        ),
      )
      externalDirectory = external
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(external, { recursive: true, force: true })))
      const registry = yield* ToolRegistry.Service

      const settled = yield* grep(
        registry,
        { pattern: "needle", path: RelativePath.make(path.join(external, "secret.txt")) },
        "call-grep-external",
      )
      expect(settled.result).toMatchObject({ type: "text" })
      expect(settled.output?.structured).toMatchObject([{ entry: { type: "file" }, text: "needle outside" }])
      expect(assertions).toMatchObject([
        { sessionID, action: "grep", resources: ["needle"] },
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
