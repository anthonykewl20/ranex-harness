import { afterEach, beforeEach, describe, expect } from "bun:test"
import { SessionV1 } from "@ranex/core/v1/session"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { CrossSpawnSpawner } from "@ranex/core/cross-spawn-spawner"

import { githubHostFromUrl, Instruction } from "../../src/session/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@ranex/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ProviderV2 } from "@ranex/core/provider"
import { ModelV2 } from "@ranex/core/model"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { LayerNodePlatform } from "@ranex/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const configLayer = Layer.succeed(Config.Service, TestConfig.make())

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request)))),
  )
}

const instructionLayer = (global: Partial<Global.Interface>, flags: Partial<RuntimeFlags.Info> = {}) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, configLayer],
    [Global.node, Global.layerWith(global)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const remoteInstructionLayer = (
  handler: (request: HttpClientRequest.HttpClientRequest) => Response,
  url = "https://raw.githubusercontent.com/acme/private/main/AGENTS.md",
) =>
  AppNodeBuilder.build(Instruction.node, [
    [
      Config.node,
      Layer.succeed(
        Config.Service,
        TestConfig.make({
          get: () => Effect.succeed({ instructions: [url] }),
        }),
      ),
    ],
    [Global.node, Global.layerWith({})],
    [RuntimeFlags.node, RuntimeFlags.layer({})],
    [LayerNodePlatform.httpClient, mockHttpClient(handler)],
  ])

const provideRemoteInstruction =
  (handler: (request: HttpClientRequest.HttpClientRequest) => Response, url?: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(remoteInstructionLayer(handler, url)))

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags)))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(files: Record<string, string>, self: (dir: string) => Effect.Effect<A, E, R>) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      yield* writeFiles(dir, files)
      return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }))
    }),
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })

function loaded(filepath: string): SessionV1.WithParts[] {
  const sessionID = SessionID.make("session-loaded-1")
  const messageID = MessageID.make("msg_message-loaded-1")

  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("anthropic"),
          modelID: ModelV2.ID.make("claude-sonnet-4-20250514"),
        },
      },
      parts: [
        {
          id: PartID.make("prt_part-loaded-1"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call-loaded-1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Read",
            metadata: { loaded: [filepath] },
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

describe("Instruction.resolve", () => {
  it.live("returns empty when AGENTS.md is at project root (already in systemPaths)", () =>
    withFiles({ "AGENTS.md": "# Root Instructions", "src/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "AGENTS.md"))).toBe(true)

        const results = yield* svc.resolve([], path.join(dir, "src", "file.ts"), MessageID.make("msg_message-test-1"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("returns AGENTS.md from subdirectory (not in systemPaths)", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "subdir", "AGENTS.md"))).toBe(false)

        const results = yield* svc.resolve(
          [],
          path.join(dir, "subdir", "nested", "file.ts"),
          MessageID.make("msg_message-test-2"),
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("doesn't reload AGENTS.md when reading it directly", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "AGENTS.md")
        const system = yield* svc.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = yield* svc.resolve([], filepath, MessageID.make("msg_message-test-3"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("does not reattach the same nearby instructions twice for one message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-1")

        const first = yield* svc.resolve([], filepath, id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(first[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
        expect(second).toEqual([])
      }),
    ),
  )

  it.live("clear allows nearby instructions to be attached again for the same message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-2")

        const first = yield* svc.resolve([], filepath, id)
        yield* svc.clear(id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)
        expect(second[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("skips instructions already reported by prior read metadata", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const agents = path.join(dir, "subdir", "AGENTS.md")
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-3")

        const results = yield* svc.resolve(loaded(agents), filepath, id)
        expect(results).toEqual([])
      }),
    ),
  )

})

const previousGithubHost = process.env.GH_HOST

describe("githubHostFromUrl", () => {
  beforeEach(() => delete process.env.GH_HOST)

  afterEach(() => {
    if (previousGithubHost === undefined) delete process.env.GH_HOST
    if (previousGithubHost !== undefined) process.env.GH_HOST = previousGithubHost
  })

  const cases = [
    ["https://raw.githubusercontent.com/acme/private/main/AGENTS.md", "github.com"],
    ["https://github.com/acme/private/raw/main/AGENTS.md", "github.com"],
    ["https://media.githubusercontent.com/acme/private/main/AGENTS.md", "github.com"],
    ["http://github.com/o/r/raw/main/x", null],
    ["https://github.example.com/acme/private/raw/main/AGENTS.md", null],
    ["https://example.com/foo", null],
    ["not a URL", null],
  ] as const

  cases.forEach(([url, host]) => {
    it.live(`maps ${url} to ${host}`, () => Effect.sync(() => expect(githubHostFromUrl(url)).toBe(host)))
  })
})

const githubEnv = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "HOME",
  "PATH",
] as const
const previousGithubEnv = Object.fromEntries(githubEnv.map((key) => [key, process.env[key]]))

describe.serial("Instruction.system remote authentication", () => {
  beforeEach(() => {
    githubEnv.forEach((key) => delete process.env[key])
    process.env.PATH = ""
  })

  afterEach(() => {
    githubEnv.forEach((key) => {
      const value = previousGithubEnv[key]
      if (value === undefined) delete process.env[key]
      if (value !== undefined) process.env[key] = value
    })
  })

  const authHeaders: Array<string | undefined> = []
  it.live("authenticates private GitHub instructions when GH_TOKEN is set", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        process.env.GH_TOKEN = "instruction-token"
        process.env.HOME = dir
        process.env.GH_CONFIG_DIR = dir
        const rules = yield* (yield* Instruction.Service).system()
        expect(rules).toHaveLength(1)
        expect(authHeaders.at(-1)).toBe("Bearer instruction-token")
      }).pipe(
        provideRemoteInstruction((request) => {
          authHeaders.push(request.headers.authorization)
          return new Response("private instructions")
        }),
      ),
    ),
  )

  const enterpriseHeaders: Array<string | undefined> = []
  it.live("authenticates private enterprise GitHub instructions when its host is configured", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const previousHost = process.env.GH_HOST
        const previousToken = process.env.GH_ENTERPRISE_TOKEN
        try {
          process.env.HOME = dir
          process.env.GH_CONFIG_DIR = dir
          process.env.GH_HOST = "github.private.example"
          process.env.GH_ENTERPRISE_TOKEN = "enterprise-instruction-token"
          const rules = yield* (yield* Instruction.Service).system()
          expect(rules).toHaveLength(1)
          expect(enterpriseHeaders.at(-1)).toBe("Bearer enterprise-instruction-token")
        } finally {
          if (previousHost === undefined) delete process.env.GH_HOST
          if (previousHost !== undefined) process.env.GH_HOST = previousHost
          if (previousToken === undefined) delete process.env.GH_ENTERPRISE_TOKEN
          if (previousToken !== undefined) process.env.GH_ENTERPRISE_TOKEN = previousToken
        }
      }).pipe(
        provideRemoteInstruction(
          (request) => {
            enterpriseHeaders.push(request.headers.authorization)
            return new Response("private enterprise instructions")
          },
          "https://github.private.example/acme/private/raw/main/AGENTS.md",
        ),
      ),
    ),
  )

  const untrustedHeaders: Array<string | undefined> = []
  it.live("does not send an enterprise token to an untrusted raw-like URL", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const previousToken = process.env.GH_ENTERPRISE_TOKEN
        try {
          process.env.HOME = dir
          process.env.GH_CONFIG_DIR = dir
          process.env.GH_ENTERPRISE_TOKEN = "enterprise-instruction-token"
          const rules = yield* (yield* Instruction.Service).system()
          expect(rules).toHaveLength(1)
          expect(untrustedHeaders.at(-1)).toBeUndefined()
        } finally {
          if (previousToken === undefined) delete process.env.GH_ENTERPRISE_TOKEN
          if (previousToken !== undefined) process.env.GH_ENTERPRISE_TOKEN = previousToken
        }
      }).pipe(
        provideRemoteInstruction(
          (request) => {
            untrustedHeaders.push(request.headers.authorization)
            return new Response("untrusted instructions")
          },
          "https://evil.com/a/raw/b",
        ),
      ),
    ),
  )
})

describe("Instruction.system", () => {
  it.live("loads both project and global AGENTS.md when both exist", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project Instructions" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(projectTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)

        const rules = yield* svc.system()
        expect(rules).toHaveLength(2)
        expect(rules[0]).toBe(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}\n# Global Instructions`)
        expect(rules[1]).toBe(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}\n# Project Instructions`)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("skips project and global CLAUDE.md when Claude Code prompt is disabled", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({ "CLAUDE.md": "# Project Claude" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, { disableClaudeCodePrompt: true }),
      )
    }),
  )
})

describe("Instruction.systemPaths global config", () => {
  it.live("uses Global.Service config AGENTS.md", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )
})
