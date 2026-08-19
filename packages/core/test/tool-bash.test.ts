import fs from "fs/promises"
import { realpathSync } from "node:fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@ranex/core/fs-util"
import { Config } from "@ranex/core/config"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Global } from "@ranex/core/global"
import { Location } from "@ranex/core/location"
import { LocationMutation } from "@ranex/core/location-mutation"
import { PermissionV2 } from "@ranex/core/permission"
import { AppProcess } from "@ranex/core/process"
import { AbsolutePath } from "@ranex/core/schema"
import { SessionV2 } from "@ranex/core/session"
import { BashTool } from "@ranex/core/tool/bash"
import { ToolRegistry } from "@ranex/core/tool/registry"
import { ToolOutputStore } from "@ranex/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_bash_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const runs: Array<{
  readonly command: string
  readonly cwd?: string
  readonly shell?: string | boolean
  readonly options?: AppProcess.RunOptions
}> = []
let denyAction: string | undefined
let result: AppProcess.RunResult = {
  command: "mock",
  exitCode: 0,
  output: Buffer.from("hello\n"),
  stdout: Buffer.from("hello\n"),
  stderr: Buffer.alloc(0),
  outputTruncated: false,
  stdoutTruncated: false,
  stderrTruncated: false,
}
let runFailure: AppProcess.AppProcessError | undefined
let afterPermission = (_input: PermissionV2.AssertInput): Effect.Effect<void> => Effect.void

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(Effect.suspend(() => afterPermission(input))),
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: (command: ChildProcess.Command, options?: AppProcess.RunOptions) =>
      Effect.suspend(() => {
        if (command._tag !== "StandardCommand") throw new Error("expected standard command")
        runs.push({ command: command.command, cwd: command.options.cwd, shell: command.options.shell, options })
        return runFailure ? Effect.fail(runFailure) : Effect.succeed(result)
      }),
  } as unknown as AppProcess.Interface),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
  }),
)

const reset = () => {
  assertions.length = 0
  runs.length = 0
  denyAction = undefined
  runFailure = undefined
  afterPermission = () => Effect.void
  result = {
    command: "mock",
    exitCode: 0,
    output: Buffer.from("hello\n"),
    stdout: Buffer.from("hello\n"),
    stderr: Buffer.alloc(0),
    outputTruncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

const withTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  processLayer: Layer.Layer<AppProcess.Service> = appProcess,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, BashTool.node]),
        [
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [AppProcess.node, processLayer],
          [Config.node, config],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (input: typeof BashTool.Input.Type, id = "call-bash") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "bash", input },
})

const it = testEffect(Layer.empty)

describe("BashTool", () => {
  it.live("registers and returns structured successful output from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const definitions = yield* toolDefinitions(registry)
            expect(definitions.map((tool) => tool.name)).toEqual(["bash"])
            expect(definitions[0]?.inputSchema).not.toHaveProperty("properties.background")
            expect(definitions[0]?.inputSchema).not.toHaveProperty("properties.description")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.output")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.command")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.cwd")
            expect(yield* toolDefinitions(registry, [{ action: "bash", resource: "*", effect: "deny" }])).toEqual([])
            expect(yield* settleTool(registry, call({ command: "pwd" }))).toEqual({
              result: {
                type: "content",
                value: [
                  { type: "text", text: "hello\n" },
                  { type: "text", text: "Command exited with code 0." },
                ],
              },
              output: {
                structured: {
                  exit: 0,
                  truncated: false,
                },
                content: [
                  { type: "text", text: "hello\n" },
                  { type: "text", text: "Command exited with code 0." },
                ],
              },
            })
            expect(runs).toMatchObject([{ command: "pwd", cwd: realpathSync(tmp.path) }])
            expect(runs[0]?.options).toMatchObject({
              combineOutput: true,
              maxOutputBytes: BashTool.MAX_CAPTURE_BYTES,
            })
            expect(assertions).toMatchObject([{ sessionID, action: "bash", resources: ["pwd"], save: ["pwd"] }])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("resolves a relative workdir from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => expect(runs).toMatchObject([{ cwd: realpathSync(path.join(tmp.path, "src")) }])),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects a workdir that stops being a directory during approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const workdir = path.join(tmp.path, "src")
        afterPermission = (input) =>
          input.action === "bash"
            ? Effect.promise(async () => {
                await fs.rm(workdir, { recursive: true })
                await fs.writeFile(workdir, "not a directory")
              }).pipe(Effect.orDie)
            : Effect.void
        return Effect.promise(() => fs.mkdir(workdir)).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => {
              expect(runs).toEqual([])
              expect(assertions.map((input) => input.action)).toEqual(["bash"])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  if (process.platform !== "win32") {
    it.live("executes a real shell command through AppProcess", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withTool(
            tmp.path,
            (registry) => settleTool(registry, call({ command: "printf core-bash" })),
            LayerNode.compile(AppProcess.node),
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.result).toEqual({
                  type: "content",
                  value: [
                    { type: "text", text: "core-bash" },
                    { type: "text", text: "Command exited with code 0." },
                  ],
                })
                expect(settled.output?.structured).toMatchObject({
                  exit: 0,
                })
                expect(settled.output?.structured).not.toHaveProperty("output")
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  it.live("approves an explicit external workdir before bash execution", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        return withTool(active.path, (registry) =>
          executeTool(registry, call({ command: "pwd", workdir: outside.path })),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", "bash"])
              expect(assertions[0]).toMatchObject({
                resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
              })
              expect(runs).toHaveLength(1)
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not execute after external-directory or bash denial", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          reset()
          denyAction = "external_directory"
          yield* withTool(active.path, (registry) =>
            executeTool(registry, call({ command: "pwd", workdir: outside.path })),
          )
          expect(assertions.map((item) => item.action)).toEqual(["external_directory"])
          expect(runs).toEqual([])

          reset()
          denyAction = "bash"
          yield* withTool(active.path, (registry) => executeTool(registry, call({ command: "pwd" })))
          expect(assertions.map((item) => item.action)).toEqual(["bash"])
          expect(runs).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("reports external command arguments as advisory warnings without enforcing approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        denyAction = "external_directory"
        const target = path.join(outside.path, "secret.txt")
        return withTool(active.path, (registry) => settleTool(registry, call({ command: `cat ${target}` }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["bash"])
              expect(runs).toHaveLength(1)
              expect(settled.output?.structured).toMatchObject({
                truncated: false,
              })
              expect(settled.output?.structured).not.toHaveProperty("warnings")
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Warnings:"),
              })
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("keeps non-zero exits useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, exitCode: 7, output: Buffer.from("HEAD full output TAIL") }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "false" }, "call-overflow"))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Command exited with code 7"),
              })
              expect(settled.output?.structured).toMatchObject({
                exit: 7,
                truncated: false,
              })
              expect(settled.output?.content[0]).toEqual({ type: "text", text: "HEAD full output TAIL" })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("surfaces bounded process-capture truncation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, outputTruncated: true }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "verbose" }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.structured).toMatchObject({ truncated: true })
              expect(settled.output?.content[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining("output capture truncated"),
              })
              expect(settled.output?.structured).not.toHaveProperty("resource")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("returns a useful timeout settlement", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        runFailure = new AppProcess.AppProcessError({ command: "sleep", cause: new Error("Timed out") })
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "sleep 60", timeout: 10 }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Command timed out"),
              })
              expect(settled.output?.structured).toMatchObject({
                timeout: true,
                truncated: false,
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

test("keeps locked deferred parity TODOs visible", async () => {
  const source = await fs.readFile(new URL("../src/tool/bash.ts", import.meta.url), "utf8")
  for (const todo of [
    "Port tree-sitter bash / PowerShell parser-based approval reduction.",
    "Port BashArity reusable command-prefix approvals.",
    "Replace token-based command-argument external-directory advisories with parser-based detection.",
    "Restore PowerShell and cmd-specific invocation/path handling on Windows.",
    "Add plugin shell.env environment augmentation once V2 plugin hooks exist.",
    "Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.",
    "Persist background job status and define restart recovery before exposing remote observation.",
    "Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.",
    "Revisit binary output handling if stdout/stderr decoding is text-only.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})

const realToolLayer = (dataRoot: string, directory: string) =>
  AppNodeBuilder.build(
    LayerNode.group([
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      LocationMutation.node,
      ToolOutputStore.node,
      BashTool.node,
    ]),
    [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
      [PermissionV2.node, permission],
      [AppProcess.node, LayerNode.compile(AppProcess.node)],
      [Config.node, config],
      [Global.node, Global.layerWith({ data: dataRoot })],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  )

const withRealTool = <A, E, R>(
  body: (input: {
    registry: ToolRegistry.Interface
    store: ToolOutputStore.Interface
    data: string
  }) => Effect.Effect<A, E, R>,
  dataRootOf: (tmp: string) => string = (tmp) => tmp,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      reset()
      return Effect.gen(function* () {
        return yield* body({
          registry: yield* ToolRegistry.Service,
          store: yield* ToolOutputStore.Service,
          data: dataRootOf(tmp.path),
        })
      }).pipe(Effect.provide(realToolLayer(dataRootOf(tmp.path), tmp.path)))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const readArtifact = (store: ToolOutputStore.Interface, file: string | undefined) =>
  store
    .readManaged({ path: file ?? "", createdAt: Date.now() })
    .pipe(
      Effect.flatMap((result) =>
        result._tag === "Read"
          ? Effect.succeed(Buffer.from(result.bytes))
          : Effect.fail(new Error(`expected readable managed artifact, got ${result._tag}`)),
      ),
    )

const withRetentionCap = <A, E, R>(bytes: number, body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prior = process.env.RANEX_TOOL_OUTPUT_RETENTION_MAX_BYTES
      process.env.RANEX_TOOL_OUTPUT_RETENTION_MAX_BYTES = String(bytes)
      return prior
    }),
    () => body,
    (prior) =>
      Effect.sync(() => {
        if (prior === undefined) delete process.env.RANEX_TOOL_OUTPUT_RETENTION_MAX_BYTES
        else process.env.RANEX_TOOL_OUTPUT_RETENTION_MAX_BYTES = prior
      }),
  )

describe("BashTool full-output retention", () => {
  it.live("retention: streams more than 1 MiB into managed storage fetchable via the out_ ref (shape i)", () =>
    withRealTool(({ registry, store }) =>
      Effect.gen(function* () {
        const lines = 220_000
        const expected = `${Array.from({ length: lines }, (_, index) => index + 1).join("\n")}\n`
        expect(Buffer.byteLength(expected)).toBeGreaterThan(BashTool.MAX_CAPTURE_BYTES)
        const settled = yield* settleTool(registry, call({ command: `seq 1 ${lines}` }, "call-retention-full"))
        // The bounded preview collapses to a single text part; only the error channel matters here.
        expect(settled.result.type).not.toBe("error")
        // Over the 1 MiB capture bound: baseline truncated semantics hold.
        expect(settled.output?.structured).toMatchObject({ exit: 0, truncated: true })
        const file = settled.outputPaths?.[0]
        const ref = settled.outputRefs?.[0]
        expect(settled.outputPaths).toHaveLength(1)
        expect(typeof ref === "string" && ref.startsWith("out_")).toBe(true)
        const artifact = yield* readArtifact(store, file)
        expect(artifact.toString("utf8")).toBe(expected)
        expect(artifact.includes(ToolOutputStore.RETENTION_TRUNCATION_MARKER_PREFIX)).toBe(false)
        // Model-visible preview stays bounded and names the managed artifact.
        const preview = settled.output?.content[0]
        if (preview?.type !== "text") throw new Error("expected text preview")
        expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
        expect(preview.text).toContain("full content saved to")
        expect(preview.text).toContain("[output capture truncated at the in-memory safety limit]")
      }),
    ),
  )

  it.live("retention shape (ii): over a small configured cap but under the capture bound appends the cap marker only", () =>
    withRetentionCap(
      4_096,
      withRealTool(({ registry, store }) =>
        Effect.gen(function* () {
          const settled = yield* settleTool(
            registry,
            call({ command: `head -c 8192 /dev/zero | tr '\\0' z` }, "call-retention-shape-2"),
          )
          // Under the 1 MiB capture bound: truncated stays false; only the durable cap truncated.
          expect(settled.output?.structured).toMatchObject({ exit: 0, truncated: false })
          const file = settled.outputPaths?.[0]
          expect(settled.outputRefs?.[0]?.startsWith("out_")).toBe(true)
          const artifact = yield* readArtifact(store, file)
          expect(artifact.subarray(0, 4_096).toString("utf8")).toBe("z".repeat(4_096))
          const marker = artifact.subarray(4_096).toString("utf8")
          expect(marker).toContain(`${ToolOutputStore.RETENTION_TRUNCATION_MARKER_PREFIX} cap=4096 actual=8192 command=`)
          expect(marker).toContain("head -c 8192 /dev/zero")
          // Byte-identical model-visible output: 8 KiB is under the preview bound, no reshaping.
          const text = settled.output?.content[0]
          if (text?.type !== "text") throw new Error("expected text output")
          expect(text.text).toBe("z".repeat(8_192))
        }),
      ),
    ),
  )

  it.live("retention shape (iii): over both the cap and the capture bound reports truncated=true plus the marker", () =>
    withRetentionCap(
      4_096,
      withRealTool(({ registry, store }) =>
        Effect.gen(function* () {
          const lines = 300_000
          const expected = `${Array.from({ length: lines }, (_, index) => index + 1).join("\n")}\n`
          const settled = yield* settleTool(registry, call({ command: `seq 1 ${lines}` }, "call-retention-shape-3"))
          expect(settled.output?.structured).toMatchObject({ exit: 0, truncated: true })
          const artifact = yield* readArtifact(store, settled.outputPaths?.[0])
          expect(artifact.subarray(0, 4_096)).toEqual(Buffer.from(expected, "utf8").subarray(0, 4_096))
          expect(artifact.subarray(4_096).toString("utf8")).toContain(
            `cap=4096 actual=${Buffer.byteLength(expected)} command=seq 1 ${lines}`,
          )
        }),
      ),
    ),
  )

  it.live("empty output: an empty managed artifact is still written and carries an out_ ref", () =>
    withRealTool(({ registry, store }) =>
      Effect.gen(function* () {
        const settled = yield* settleTool(registry, call({ command: "true" }, "call-retention-empty"))
        expect(settled.result.type).toBe("content")
        expect(settled.output?.structured).toMatchObject({ exit: 0, truncated: false })
        expect(settled.outputRefs?.[0]?.startsWith("out_")).toBe(true)
        const artifact = yield* readArtifact(store, settled.outputPaths?.[0])
        expect(artifact.length).toBe(0)
      }),
    ),
  )

  it.live("concurrent: each call streams to its own per-call artifact with zero cross-contamination", () =>
    withRealTool(({ registry, store }) =>
      Effect.gen(function* () {
        const [first, second] = yield* Effect.all([
          settleTool(registry, call({ command: `head -c 131072 /dev/zero | tr '\\0' a` }, "call-concurrent-a")),
          settleTool(registry, call({ command: `head -c 131072 /dev/zero | tr '\\0' b` }, "call-concurrent-b")),
        ])
        const firstFile = first.outputPaths?.[0]
        const secondFile = second.outputPaths?.[0]
        expect(typeof firstFile === "string" && typeof secondFile === "string").toBe(true)
        expect(firstFile).not.toBe(secondFile)
        expect(first.outputRefs?.[0]).not.toBe(second.outputRefs?.[0])
        expect((yield* readArtifact(store, firstFile)).toString("utf8")).toBe("a".repeat(131_072))
        expect((yield* readArtifact(store, secondFile)).toString("utf8")).toBe("b".repeat(131_072))
      }),
    ),
  )
})

describe("BashTool retention storage failure handling", () => {
  it.live("storage failure before spawn: fails the call with a stable error naming the managed tool-output sink", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "blocked"), "not a directory")).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              const settled = yield* settleTool(
                registry,
                call({ command: "printf should-not-run" }, "call-sink-unavailable"),
              )
              expect(settled.result).toEqual({
                type: "error",
                value: expect.stringContaining("Unable to open managed tool-output sink"),
              })
            }),
          ),
          Effect.provide(realToolLayer(path.join(tmp.path, "blocked", "data"), tmp.path)),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("storage failure mid-stream on an exit-0 command: lossy success with diagnostics and no out_ ref", () =>
    withRealTool(({ registry, data }) =>
      Effect.gen(function* () {
        const managed = path.join(data, ToolOutputStore.MANAGED_DIRECTORY)
        // The sink artifact is created before spawn; a concurrent watcher revokes its writability
        // as soon as it appears, then the delayed command output finds a broken sink mid-stream.
        const watcher = yield* Effect.promise(async () => {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const entries = await fs.readdir(managed).catch(() => [] as string[])
            const file = entries.find((entry) => entry.startsWith("tool_"))
            if (file) {
              await fs.chmod(path.join(managed, file), 0o400)
              return path.join(managed, file)
            }
            await Bun.sleep(5)
          }
          throw new Error("sink artifact did not appear before spawn")
        }).pipe(Effect.forkChild)
        const settled = yield* settleTool(
          registry,
          call({ command: "sleep 0.4; printf retained-then-lossy" }, "call-storage-failure-mid"),
        )
        const artifact = yield* Fiber.join(watcher)
        // The command exited 0: the tool call stays successful, explicitly lossy.
        expect(settled.result.type).toBe("content")
        expect(settled.output?.structured).toMatchObject({ exit: 0, truncated: false })
        expect(settled.outputPaths).toBeUndefined()
        expect(settled.outputRefs).toBeUndefined()
        const text = settled.output?.content[0]
        if (text?.type !== "text") throw new Error("expected text output")
        expect(text.text).toContain("retained-then-lossy")
        expect(text.text).toContain("[full-output retention failed; the output above is lossy and no out_ reference is available]")
        const summary = settled.output?.content[1]
        if (summary?.type !== "text") throw new Error("expected summary output")
        expect(summary.text).toContain("Warnings:")
        expect(summary.text).toContain("Full command output retention failed")
        // The partial artifact is marked incomplete rather than reading as complete.
        expect(yield* Effect.promise(() => Bun.file(`${artifact}.incomplete`).exists())).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(artifact).exists())).toBe(false)
      }),
    ),
  )

  it.live("storage failure on timeout: already-streamed bytes stay fetchable via the out_ ref", () =>
    withRealTool(({ registry, store }) =>
      Effect.gen(function* () {
        const settled = yield* settleTool(
          registry,
          call({ command: "printf streamed-before-timeout; sleep 5", timeout: 500 }, "call-timeout-stream"),
        )
        expect(settled.output?.structured).toMatchObject({ timeout: true, truncated: false })
        expect(settled.output?.content[1]).toMatchObject({
          type: "text",
          text: expect.stringContaining("Command timed out"),
        })
        expect(settled.outputRefs?.[0]?.startsWith("out_")).toBe(true)
        expect((yield* readArtifact(store, settled.outputPaths?.[0])).toString("utf8")).toBe(
          "streamed-before-timeout",
        )
      }),
    ),
  )

  it.live("binary: stores invalid-UTF8 and multibyte chunks byte-exactly with unchanged preview decoding", () =>
    withRealTool(({ registry, store }) =>
      Effect.gen(function* () {
        const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("🏁", "utf8"), Buffer.from([0x80])])
        const settled = yield* settleTool(
          registry,
          call({ command: "printf '\\377\\376\\360\\237\\217\\201\\200'" }, "call-binary"),
        )
        expect(settled.output?.structured).toMatchObject({ exit: 0, truncated: false })
        expect(Buffer.compare(yield* readArtifact(store, settled.outputPaths?.[0]), bytes)).toBe(0)
      }),
    ),
  )
})
