import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@ranex/core/config"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Global } from "@ranex/core/global"
import { Location } from "@ranex/core/location"
import { Policy } from "@ranex/core/policy"
import { AbsolutePath } from "@ranex/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Mirrors the testLayer helper from config.test.ts: builds the Config and
// Policy nodes against a temp directory with a separate global config
// directory, then resolves project config through loadProject.
const it = testEffect(Layer.empty)

function testLayer(directory: string, globalDirectory = path.join(directory, "global")) {
  const project = AbsolutePath.make(directory)
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const base = AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: globalDirectory })],
  ])
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* Config.Service
      if (config.loadProject) yield* config.loadProject(project).pipe(Effect.orDie)
    }),
  ).pipe(Layer.provideMerge(base))
}

const allowOpenAi = JSON.stringify({
  experimental: { policies: [{ effect: "allow", action: "provider.use", resource: "openai" }] },
})

describe("config policy scope", () => {
  it.live("ignores experimental.policies from project documents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.writeFile(path.join(global, "ranex.json"), JSON.stringify({ model: "test/model" }))
            await fs.writeFile(path.join(tmp.path, "ranex.json"), allowOpenAi)
          })

          return yield* Effect.gen(function* () {
            const policy = yield* Policy.Service
            const config = yield* Config.Service

            expect((yield* config.entries()).length).toBeGreaterThan(1)
            expect(yield* policy.hasStatements()).toBe(false)
            expect(yield* policy.evaluate("provider.use", "openai", "deny")).toBe("deny")
          }).pipe(Effect.provide(testLayer(tmp.path, global)))
        })
      }),
    ),
  )

  it.live("ignores experimental.policies from project config directories", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const dotDir = path.join(tmp.path, ".ranex")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(dotDir, { recursive: true })
            await fs.writeFile(path.join(global, "ranex.json"), JSON.stringify({}))
            await fs.writeFile(path.join(dotDir, "ranex.json"), allowOpenAi)
          })

          return yield* Effect.gen(function* () {
            const policy = yield* Policy.Service

            expect(yield* policy.hasStatements()).toBe(false)
            expect(yield* policy.evaluate("provider.use", "openai", "deny")).toBe("deny")
          }).pipe(Effect.provide(testLayer(tmp.path, global)))
        })
      }),
    ),
  )

  it.live("honors experimental.policies from global documents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.writeFile(
              path.join(global, "ranex.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "openai" }] },
              }),
            )
            await fs.writeFile(path.join(tmp.path, "ranex.json"), allowOpenAi)
          })

          return yield* Effect.gen(function* () {
            const policy = yield* Policy.Service

            expect(yield* policy.hasStatements()).toBe(true)
            // Only the global deny statement loaded; the project allow was ignored.
            expect(yield* policy.evaluate("provider.use", "openai", "allow")).toBe("deny")
          }).pipe(Effect.provide(testLayer(tmp.path, global)))
        })
      }),
    ),
  )
})
