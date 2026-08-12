import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LLMClient, LLMError, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@ranex/llm"
import * as OpenAIChat from "@ranex/llm/protocols/openai-chat"
import { AgentV2 } from "@ranex/core/agent"
import { Config } from "@ranex/core/config"
import { ConfigCompaction } from "@ranex/core/config/compaction"
import { ConfigProviderWatchdog } from "@ranex/core/config/provider-watchdog"
import { Database } from "@ranex/core/database/database"
import { makeLocationNode } from "@ranex/core/effect/app-node"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ranex/core/effect/app-node-platform"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { EventV2 } from "@ranex/core/event"
import { Global } from "@ranex/core/global"
import { Location } from "@ranex/core/location"
import { PermissionV2 } from "@ranex/core/permission"
import { Policy } from "@ranex/core/policy"
import { Project } from "@ranex/core/project"
import { ProjectTable } from "@ranex/core/project/sql"
import { QuestionV2 } from "@ranex/core/question"
import { ReferenceGuidance } from "@ranex/core/reference/guidance"
import { AbsolutePath } from "@ranex/core/schema"
import { SessionV2 } from "@ranex/core/session"
import { SessionExecution } from "@ranex/core/session/execution"
import { Prompt } from "@ranex/core/session/prompt"
import { SessionProjector } from "@ranex/core/session/projector"
import { SessionRunCoordinator } from "@ranex/core/session/run-coordinator"
import { SessionRunner } from "@ranex/core/session/runner"
import * as SessionRunnerLLM from "@ranex/core/session/runner/llm"
import { SessionRunnerModel } from "@ranex/core/session/runner/model"
import { ProviderWatchdog } from "@ranex/core/session/runner/provider-watchdog"
import { SessionTurnLLM } from "@ranex/core/session/runner/turn-llm"
import { SessionTable } from "@ranex/core/session/sql"
import { SessionStore } from "@ranex/core/session/store"
import { SkillGuidance } from "@ranex/core/skill/guidance"
import { Snapshot } from "@ranex/core/snapshot"
import { SystemContext } from "@ranex/core/system-context"
import { SystemContextRegistry } from "@ranex/core/system-context/registry"
import { ApplicationTools } from "@ranex/core/tool/application-tools"
import { Tool } from "@ranex/core/tool/tool"
import { ToolRegistry } from "@ranex/core/tool/registry"
import { Cause, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

let responseStream: Stream.Stream<LLMEvent, LLMError> | undefined

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
const sessionID = SessionV2.ID.make("ses_watchdog_config_test")

function runnerIt(watchdogConfig: ConfigProviderWatchdog.Info) {
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
              provider_watchdog: watchdogConfig,
            }),
          }),
        ]),
    }),
  )
  const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
    [Snapshot.node, Snapshot.noopLayer],
    [LayerNodePlatform.llmClient, client],
    [SessionTurnLLM.node, SessionTurnLLM.layerFrom(client)],
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
        drain: (id, force) => sessionRunner.run({ sessionID: id, force }),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        resume: coordinator.run,
        wake: coordinator.wake,
        interrupt: coordinator.interrupt,
      })
    }),
  ).pipe(Layer.provide(runnerLayer))
  return testEffect(
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
        [SessionTurnLLM.node, SessionTurnLLM.layerFrom(client)],
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
}

const insertSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

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

describe("ProviderWatchdog configuration (SLICE-012 criterion 5)", () => {
  const defaultsIt = testEffect(
    AppNodeBuilder.build(ProviderWatchdog.node, [
      [
        Config.node,
        Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
      ],
    ]),
  )

  defaultsIt.effect("uses shipped defaults when provider_watchdog is omitted", () =>
    Effect.gen(function* () {
      const watchdog = yield* ProviderWatchdog.Service
      expect(watchdog).toEqual({ idle: 30_000, absolute: 1_800_000 })
    }),
  )

  testEffect(Layer.empty).effect("refuses invalid effective pairs after per-field document merging", () =>
    Effect.forEach(
      [
        {
          watchdogs: [new ConfigProviderWatchdog.Info({ absolute_ms: 10_000 })],
          message: "idle_ms (30000) must not exceed absolute_ms (10000)",
        },
        {
          watchdogs: [
            new ConfigProviderWatchdog.Info({ idle_ms: 600_000 }),
            new ConfigProviderWatchdog.Info({ absolute_ms: 100_000 }),
          ],
          message: "idle_ms (600000) must not exceed absolute_ms (100000)",
        },
      ],
      (example) =>
        Effect.gen(function* () {
          const config = Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () =>
                Effect.succeed(
                  example.watchdogs.map(
                    (provider_watchdog) =>
                      new Config.Document({
                        type: "document",
                        info: new Config.Info({ provider_watchdog }),
                      }),
                  ),
                ),
            }),
          )
          const exit = yield* Layer.build(
            AppNodeBuilder.build(ProviderWatchdog.node, [[Config.node, config]]),
          ).pipe(Effect.scoped, Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(example.message)
        }),
    ),
  )

  runnerIt(new ConfigProviderWatchdog.Info({ idle_ms: 120, absolute_ms: 10_000 })).live(
    "idle_ms below a 300ms gap cuts the provider stream",
    () =>
      Effect.gen(function* () {
        responseStream = undefined
        yield* insertSession
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

  runnerIt(new ConfigProviderWatchdog.Info({ idle_ms: 3_000, absolute_ms: 10_000 })).live(
    "idle_ms above the same 300ms gap lets the provider stream complete",
    () =>
      Effect.gen(function* () {
        responseStream = undefined
        yield* insertSession
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Gated slow" }), resume: false })
        responseStream = gatedSlowStream()
        const runner = yield* SessionRunner.Service
        yield* runner.run({ sessionID, force: true })
        expect(yield* session.context(sessionID)).toMatchObject([
          { type: "user", text: "Gated slow" },
          { type: "assistant", finish: "stop", content: [{ type: "text", text: "FirstSecond" }] },
        ])
      }),
  )
})

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

  decodeIt.effect("refuses idle_ms greater than absolute_ms at load and accepts the neighbours", () =>
    Effect.sync(() => {
      expect(Option.isNone(decode({ provider_watchdog: { idle_ms: 2_000, absolute_ms: 1_000 } }))).toBe(true)
      expect(Option.isSome(decode({ provider_watchdog: { idle_ms: 1_000, absolute_ms: 1_000 } }))).toBe(true)
      expect(Option.isSome(decode({ provider_watchdog: { idle_ms: 2_000 } }))).toBe(true)
      expect(Option.isSome(decode({ provider_watchdog: { absolute_ms: 1_000 } }))).toBe(true)
      expect(Option.isSome(decode({ provider_watchdog: { idle_ms: 1_000, absolute_ms: 2_000 } }))).toBe(true)
    }),
  )

  decodeIt.effect("the cross-field refusal carries a clear message naming both values", () =>
    Effect.sync(() => {
      expect(() => decodeSync({ provider_watchdog: { idle_ms: 2_000, absolute_ms: 1_000 } })).toThrow(
        "idle_ms (2000) must not exceed absolute_ms (1000)",
      )
    }),
  )

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
