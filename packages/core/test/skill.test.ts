import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@ranex/core/agent"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { FSUtil } from "@ranex/core/fs-util"
import { buildLocationServiceMap, LocationServiceMap } from "@ranex/core/location-services"
import { Location } from "@ranex/core/location"
import { AbsolutePath } from "@ranex/core/schema"
import { SkillV2 } from "@ranex/core/skill"
import { SkillDiscovery } from "@ranex/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [[SkillDiscovery.node, discovery]]),
)

function write(directory: string, name: string, description: string) {
  const file = path.join(directory, name, "SKILL.md")
  return fs
    .mkdir(path.dirname(file), { recursive: true })
    .then(() =>
      fs.writeFile(
        file,
        `---
name: ${name}
description: ${description}
---
# ${name}`,
      ),
    )
}

describe("SkillV2", () => {
  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "review", "Second")
            await fs.writeFile(path.join(first, "foo.md"), "---\nslash: true\n---\n# foo")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          expect(yield* skill.list()).toEqual([
            SkillV2.Info.make({
              name: "foo",
              slash: true,
              location: AbsolutePath.make(path.join(first, "foo.md")),
              content: "# foo",
            }),
            {
              name: "review",
              description: "Second",
              location: AbsolutePath.make(path.join(second, "review", "SKILL.md")),
              content: "# review",
            },
          ])
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect(pulls).toBe(1)
          expect(SkillV2.available(yield* skill.list(), (yield* agents.get(AgentV2.ID.make("reviewer")))!)).toEqual([])
        }),
      ),
    ),
  )

  it.live("refresh() picks up a new SKILL.md created after initial load", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "existing"), { recursive: true })
            await write(first, "existing", "Existing skill")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(first) }))
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["existing"])

          yield* Effect.promise(() => write(first, "added", "Added skill"))
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["existing"])

          yield* skill.refresh()
          expect((yield* skill.list()).map((item) => item.name).toSorted()).toEqual(["added", "existing"])
        }),
      ),
    ),
  )

  it.live("refresh() drops a removed skill", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "gone"), { recursive: true })
            await write(first, "kept", "Kept skill")
            await write(first, "gone", "Removed skill")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(first) }))
          expect((yield* skill.list()).map((item) => item.name).toSorted()).toEqual(["gone", "kept"])

          yield* Effect.promise(() => fs.rm(path.join(first, "gone"), { recursive: true, force: true }))
          yield* skill.refresh()
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["kept"])
        }),
      ),
    ),
  )

  it.live("refresh() surfaces edited SKILL.md guidance", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "edited"), { recursive: true })
            await write(first, "edited", "Before edit")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(first) }))
          expect((yield* skill.list()).find((item) => item.name === "edited")?.description).toBe("Before edit")

          yield* Effect.promise(() => write(first, "edited", "After edit"))
          yield* skill.refresh()
          expect((yield* skill.list()).find((item) => item.name === "edited")?.description).toBe("After edit")
        }),
      ),
    ),
  )
})

// Distinct Location refs through one LocationServiceMap exercise real
// per-location skill caches in a single process.
const locationIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([LocationServiceMap.node]), [
    [LocationServiceMap.node, buildLocationServiceMap([[SkillDiscovery.node, discovery]])],
  ]),
)

describe("SkillV2 locations", () => {
  locationIt.live(
    "refresh() re-pulls HTTP sources and leaves other locations' caches untouched",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const first = path.join(tmp.path, "first")
            const second = path.join(tmp.path, "second")
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(first, "deploy"), { recursive: true })
              await fs.mkdir(path.join(second, "deploy"), { recursive: true })
              await write(first, "deploy", "First deploy")
              await write(second, "deploy", "Second deploy")
            })
            urls.set("https://example.test/a/", [AbsolutePath.make(first)])
            urls.set("https://example.test/b/", [AbsolutePath.make(second)])
            pulls = 0

            const locations = yield* LocationServiceMap.Service
            const firstLocation = locations.get(Location.Ref.make({ directory: AbsolutePath.make(first) }))
            const secondLocation = locations.get(Location.Ref.make({ directory: AbsolutePath.make(second) }))
            const load = (url: string) =>
              Effect.gen(function* () {
                const skill = yield* SkillV2.Service
                yield* skill.transform((editor) => editor.source({ type: "url", url }))
                return (yield* skill.list()).find((item) => item.name === "deploy")?.description
              })
            const description = (url: string) => load(url).pipe(Effect.map((item) => item))

            expect(yield* description("https://example.test/a/").pipe(Effect.provide(firstLocation))).toBe(
              "First deploy",
            )
            expect(pulls).toBe(1)
            expect(yield* description("https://example.test/b/").pipe(Effect.provide(secondLocation))).toBe(
              "Second deploy",
            )
            expect(pulls).toBe(2)

            yield* Effect.promise(() => write(first, "deploy", "First deploy edited"))
            yield* Effect.flatMap(SkillV2.Service, (skill) => skill.refresh()).pipe(Effect.provide(firstLocation))
            expect(pulls).toBe(3)
            expect(
              yield* Effect.flatMap(SkillV2.Service, (skill) => skill.list())
                .pipe(Effect.map((list) => list.find((item) => item.name === "deploy")?.description))
                .pipe(Effect.provide(firstLocation)),
            ).toBe("First deploy edited")
            expect(pulls).toBe(3)

            // The other location's cache was not cleared: its list still
            // serves from cache and the HTTP source is not pulled again.
            expect(
              yield* Effect.flatMap(SkillV2.Service, (skill) => skill.list())
                .pipe(Effect.map((list) => list.find((item) => item.name === "deploy")?.description))
                .pipe(Effect.provide(secondLocation)),
            ).toBe("Second deploy")
            expect(pulls).toBe(3)
          }),
        ),
      ),
    20_000,
  )
})
