import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LLMClient, LLMError, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { ConfigProviderWatchdog } from "@opencode-ai/core/config/provider-watchdog"
import { Database } from "@opencode-ai/core/database/database"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Policy } from "@opencode-ai/core/policy"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// ---- Runner harness: stalls a real provider stream inside the runner. ----
// Required by SLICE-012 decoration warning 1: a timeout-helper assertion proves
// nothing about llm.stream; the stall must run through SessionRunner.run.

let responseStream: Stream.Stream<LLMEvent, LLMError> | undefined
let watchdogConfig: ConfigProviderWatchdog.Info | undefined

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      void request
      if (responseStream) {
        const stream = responseStream
        responseStream = undefined
        return stream
      }
      return Stream.empty
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }) => Effect.succeed({ text }),
      }),
    }),
  ),
)
const echoNode = makeLocationNode({ name: "test/watchdog-config-tools", layer: echo, deps: [ToolRegistry.node] })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const systemContextKey = SystemContext.Key.make("test/context")
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.succeed(
          SystemContext.combine([
            SystemContext.make({
              key: systemContextKey,
              codec: Schema.toCodecJson(Schema.String),
              load: Effect.succeed("Initial context"),
              baseline: String,
              update: (_previous, current) => current,
              removed: () => "System context source removed: test/context",
            }),
          ]),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
            ...(watchdogConfig ? { provider_watchdog: watchdogConfig } : {}),
          }),
        }),
      ]),
  }),
)
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [Config.node, config],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      echoNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_watchdog_config_test")

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  responseStream = undefined
  watchdogConfig = undefined
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

// A stream that emits a few chunks then stalls forever (silent mid-stream).
const stallStream = (text: string) =>
  Stream.concat(
    Stream.fromIterable([
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: "text-stall" }),
      LLMEvent.textDelta({ id: "text-stall", text }),
    ]),
    Stream.never,
  )

describe("ProviderWatchdog configuration (SLICE-012 criterion 5)", () => {
  it.live("default (no watchdog config): a stalled stream hangs past budget", () =>
    Effect.gen(function* () {
      yield* setup
      // DEFAULT_PROVIDER_WATCHDOG is undefined pending terminal 6's values, so
      // the default is OFF today. This test pins that current behaviour; when
      // terminal 6 fills the defaults it must be replaced by a default-ON test.
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Stall mid-stream" }), resume: false })
      responseStream = stallStream("Partial")
      const runner = yield* SessionRunner.Service
      const result = yield* Effect.raceFirst(
        runner.run({ sessionID, force: true }),
        Effect.sleep("1200 millis").pipe(Effect.as("HUNG-PAST-BUDGET" as const)),
      )
      expect(result).toBe("HUNG-PAST-BUDGET")
    }),
  )

  it.live("a configured idle threshold terminates a stalled stream (non-default changes behaviour)", () =>
    Effect.gen(function* () {
      yield* setup
      watchdogConfig = new ConfigProviderWatchdog.Info({ idle_ms: 400, absolute_ms: 5_000 })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Stall mid-stream" }), resume: false })
      responseStream = stallStream("Partial")
      const runner = yield* SessionRunner.Service
      const start = Date.now()
      const exit = yield* runner.run({ sessionID, force: true }).pipe(Effect.exit)
      const elapsed = Date.now() - start
      expect(Exit.isFailure(exit)).toBe(true)
      expect(elapsed).toBeLessThan(1500)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Stall mid-stream" },
        { type: "assistant", finish: "error", error: { message: expect.stringContaining("idle timeout") } },
      ])
    }),
  )

  // Threshold discrimination: the SAME stream, two different configured idle_ms,
  // gives two outcomes. A test that only read a constant back could not do this.
  // The stream emits one chunk, waits 300ms, emits a second chunk, then completes.
  const gatedSlowStream = () =>
    Stream.concat(
      Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-gated" }),
        LLMEvent.textDelta({ id: "text-gated", text: "First" }),
      ]),
      Stream.fromEffect(Effect.sleep("300 millis")).pipe(
        Stream.flatMap(() =>
          Stream.fromIterable([
            LLMEvent.textDelta({ id: "text-gated", text: "Second" }),
            LLMEvent.textEnd({ id: "text-gated" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ]),
        ),
      ),
    )

  it.live("threshold discrimination: idle_ms below the 300ms gap cuts the stream", () =>
    Effect.gen(function* () {
      yield* setup
      // 120ms idle < 300ms gap: the idle watchdog fires before the second chunk.
      watchdogConfig = new ConfigProviderWatchdog.Info({ idle_ms: 120, absolute_ms: 10_000 })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Gated slow" }), resume: false })
      responseStream = gatedSlowStream()
      const runner = yield* SessionRunner.Service
      const exit = yield* runner.run({ sessionID, force: true }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Gated slow" },
        { type: "assistant", finish: "error", error: { message: expect.stringContaining("idle timeout") } },
      ])
    }),
  )

  it.live("threshold discrimination: idle_ms above the 300ms gap lets the stream complete", () =>
    Effect.gen(function* () {
      yield* setup
      // 3000ms idle > 300ms gap: the gap is within budget, the stream completes.
      watchdogConfig = new ConfigProviderWatchdog.Info({ idle_ms: 3_000, absolute_ms: 10_000 })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Gated slow" }), resume: false })
      responseStream = gatedSlowStream()
      const runner = yield* SessionRunner.Service
      yield* runner.run({ sessionID, force: true })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Gated slow" },
        {
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", text: "FirstSecond" }],
        },
      ])
    }),
  )
})

// ---- Refusal at load: out-of-bounds values are rejected by the loader's own decoder. ----

const decode = Schema.decodeUnknownOption(Config.Info, {
  errors: "all",
  onExcessProperty: "ignore",
  propertyOrder: "original",
})
const decodeSync = Schema.decodeUnknownSync(Config.Info, {
  errors: "all",
  onExcessProperty: "ignore",
  propertyOrder: "original",
})

const decodeIt = testEffect(Layer.empty)

describe("ProviderWatchdog schema bounds (refused at load, not at use)", () => {
  decodeIt.effect("rejects non-positive idle_ms and accepts the positive neighbour", () =>
    Effect.sync(() => {
      expect(Option.isNone(decode({ provider_watchdog: { idle_ms: 0 } }))).toBe(true)
      expect(Option.isNone(decode({ provider_watchdog: { idle_ms: -100 } }))).toBe(true)
      expect(Option.isNone(decode({ provider_watchdog: { idle_ms: 1.5 } }))).toBe(true)
      expect(Option.isNone(decode({ provider_watchdog: { idle_ms: "400" } }))).toBe(true)
      const neighbour = decode({ provider_watchdog: { idle_ms: 1 } })
      expect(Option.isSome(neighbour)).toBe(true)
      if (Option.isSome(neighbour)) expect(neighbour.value.provider_watchdog?.idle_ms).toBe(1)
    }),
  )

  decodeIt.effect("rejects idle_ms above the 600_000ms ceiling and accepts the ceiling", () =>
    Effect.sync(() => {
      expect(Option.isNone(decode({ provider_watchdog: { idle_ms: 600_001 } }))).toBe(true)
      const ceiling = decode({ provider_watchdog: { idle_ms: 600_000 } })
      expect(Option.isSome(ceiling)).toBe(true)
      if (Option.isSome(ceiling)) expect(ceiling.value.provider_watchdog?.idle_ms).toBe(600_000)
    }),
  )

  decodeIt.effect("rejects absolute_ms above the 3_600_000ms ceiling and accepts the ceiling", () =>
    Effect.sync(() => {
      expect(Option.isNone(decode({ provider_watchdog: { absolute_ms: 3_600_001 } }))).toBe(true)
      expect(Option.isNone(decode({ provider_watchdog: { absolute_ms: 0 } }))).toBe(true)
      const ceiling = decode({ provider_watchdog: { absolute_ms: 3_600_000 } })
      expect(Option.isSome(ceiling)).toBe(true)
      if (Option.isSome(ceiling)) expect(ceiling.value.provider_watchdog?.absolute_ms).toBe(3_600_000)
    }),
  )

  decodeIt.effect("accepts a fully valid watchdog and preserves both fields", () =>
    Effect.sync(() => {
      const valid = decode({ provider_watchdog: { idle_ms: 500, absolute_ms: 10_000 } })
      expect(Option.isSome(valid)).toBe(true)
      if (Option.isSome(valid)) {
        expect(valid.value.provider_watchdog?.idle_ms).toBe(500)
        expect(valid.value.provider_watchdog?.absolute_ms).toBe(10_000)
      }
    }),
  )

  // Cross-field rule: idle_ms > absolute_ms means the idle watchdog can never
  // fire before the whole-turn budget cuts in — config that silently does
  // nothing. Refused at load (decode), not deferred to use.
  decodeIt.effect("refuses idle_ms greater than absolute_ms at load and accepts the neighbours", () =>
    Effect.sync(() => {
      expect(Option.isNone(decode({ provider_watchdog: { idle_ms: 2_000, absolute_ms: 1_000 } }))).toBe(true)
      // equality is allowed (idle can still race absolute); only strict excess is unreachable
      expect(Option.isSome(decode({ provider_watchdog: { idle_ms: 1_000, absolute_ms: 1_000 } }))).toBe(true)
      // a single field set cannot violate the cross-field rule
      expect(Option.isSome(decode({ provider_watchdog: { idle_ms: 2_000 } }))).toBe(true)
      expect(Option.isSome(decode({ provider_watchdog: { absolute_ms: 1_000 } }))).toBe(true)
      // the in-bounds neighbour of the refused pair loads
      expect(Option.isSome(decode({ provider_watchdog: { idle_ms: 1_000, absolute_ms: 2_000 } }))).toBe(true)
    }),
  )

  decodeIt.effect("the cross-field refusal carries a clear, actionable message naming both values", () =>
    Effect.sync(() => {
      let caught: unknown = new Error("no throw")
      try {
        decodeSync({ provider_watchdog: { idle_ms: 2_000, absolute_ms: 1_000 } })
      } catch (error) {
        caught = error
      }
      const message = String(caught)
      expect(message).toContain("idle_ms (2000) must not exceed absolute_ms (1000)")
      expect(message).toContain("unreachable")
    }),
  )

  // End-to-end through the real filesystem loader. The Config layer captures its
  // documents at build time, so it is provided to a gen that runs only AFTER the
  // file is written — otherwise the loader would build against an empty tree.
  decodeIt.live("the filesystem loader drops a document whose watchdog field is out of bounds", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "ranex.json"), JSON.stringify({ provider_watchdog: { idle_ms: 0 } })),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter(
              (entry): entry is Config.Document => entry.type === "document",
            )
            expect(documents).toHaveLength(0)
          }).pipe(Effect.provide(configLoadLayer(tmp.path)))
        }),
      ),
    ),
  )

  decodeIt.live("the filesystem loader keeps a document whose watchdog field is valid", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "ranex.json"),
              JSON.stringify({ provider_watchdog: { idle_ms: 500 } }),
            ),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter(
              (entry): entry is Config.Document => entry.type === "document",
            )
            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.provider_watchdog?.idle_ms).toBe(500)
          }).pipe(Effect.provide(configLoadLayer(tmp.path)))
        }),
      ),
    ),
  )

  decodeIt.live("the filesystem loader drops a document whose idle_ms exceeds absolute_ms", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "ranex.json"),
              JSON.stringify({ provider_watchdog: { idle_ms: 2_000, absolute_ms: 1_000 } }),
            ),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter(
              (entry): entry is Config.Document => entry.type === "document",
            )
            expect(documents).toHaveLength(0)
          }).pipe(Effect.provide(configLoadLayer(tmp.path)))
        }),
      ),
    ),
  )
})

function configLoadLayer(directory: string) {
  return AppNodeBuilder.build(LayerNode.group([Config.node, Policy.node]), [
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location(
            { directory: AbsolutePath.make(directory) },
            { projectDirectory: AbsolutePath.make(directory) },
          ),
        ),
      ),
    ],
    [Global.node, Global.layerWith({ config: path.join(directory, "global") })],
  ])
}
