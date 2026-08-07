import { expect } from "bun:test"
import { LLMClient, LLMError, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Database } from "@opencode-ai/core/database/database"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { ProviderWatchdogConfig } from "@opencode-ai/core/session/runner/llm"
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
import { Effect, Exit, Layer, Schema, Stream } from "effect"
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
const echoNode = makeLocationNode({ name: "test/watchdog-tools", layer: echo, deps: [ToolRegistry.node] })
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
const sessionID = SessionV2.ID.make("ses_runner_test")

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
  ProviderWatchdogConfig.idle = undefined
  ProviderWatchdogConfig.absolute = undefined
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

it.live("RED: a stalled provider stream hangs the run with no watchdog", () =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    yield* session.prompt({
      sessionID,
      prompt: Prompt.make({ text: "Stall mid-stream" }),
      resume: false,
    })
    responseStream = Stream.concat(
      Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-stall" }),
        LLMEvent.textDelta({ id: "text-stall", text: "Partial" }),
      ]),
      Stream.never,
    )
    const runner = yield* SessionRunner.Service
    const start = Date.now()
    const result = yield* Effect.raceFirst(
      runner.run({ sessionID, force: true }),
      Effect.sleep("1500 millis").pipe(Effect.as("HUNG-PAST-BUDGET" as const)),
    )
    const elapsed = Date.now() - start
    console.log(`[RED] stalled run did not terminate within budget; race=${result} elapsed=${elapsed}ms`)
    expect(result).toBe("HUNG-PAST-BUDGET")
  }),
)

it.live("GREEN: the watchdog terminates a stalled provider stream", () =>
  Effect.gen(function* () {
    yield* setup
    ProviderWatchdogConfig.idle = "400 millis"
    ProviderWatchdogConfig.absolute = "3000 millis"
    const session = yield* SessionV2.Service
    yield* session.prompt({
      sessionID,
      prompt: Prompt.make({ text: "Stall mid-stream" }),
      resume: false,
    })
    responseStream = Stream.concat(
      Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-stall" }),
        LLMEvent.textDelta({ id: "text-stall", text: "Partial" }),
      ]),
      Stream.never,
    )
    const runner = yield* SessionRunner.Service
    const start = Date.now()
    const exit = yield* runner.run({ sessionID, force: true }).pipe(Effect.exit)
    const elapsed = Date.now() - start
    console.log(`[GREEN] watchdog terminated stalled run; exit=${exit._tag} elapsed=${elapsed}ms`)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(elapsed).toBeLessThan(1500)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: "Stall mid-stream" },
      {
        type: "assistant",
        finish: "error",
        error: { message: expect.stringContaining("idle timeout") },
      },
    ])
  }),
)

it.live("NEGATIVE CONTROL: a stalled provider still hangs with the watchdog off", () =>
  Effect.gen(function* () {
    yield* setup
    ProviderWatchdogConfig.idle = undefined
    ProviderWatchdogConfig.absolute = undefined
    const session = yield* SessionV2.Service
    yield* session.prompt({
      sessionID,
      prompt: Prompt.make({ text: "Stall mid-stream" }),
      resume: false,
    })
    responseStream = Stream.concat(
      Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-stall" }),
        LLMEvent.textDelta({ id: "text-stall", text: "Partial" }),
      ]),
      Stream.never,
    )
    const runner = yield* SessionRunner.Service
    const start = Date.now()
    const result = yield* Effect.raceFirst(
      runner.run({ sessionID, force: true }),
      Effect.sleep("1500 millis").pipe(Effect.as("HUNG-PAST-BUDGET" as const)),
    )
    const elapsed = Date.now() - start
    console.log(`[NEG] watchdog off; stalled run still hangs; race=${result} elapsed=${elapsed}ms`)
    expect(result).toBe("HUNG-PAST-BUDGET")
  }),
)

it.live("SLOW STREAM: a healthy slow provider stream is not falsely cut", () =>
  Effect.gen(function* () {
    yield* setup
    ProviderWatchdogConfig.idle = "400 millis"
    ProviderWatchdogConfig.absolute = "3000 millis"
    const session = yield* SessionV2.Service
    yield* session.prompt({
      sessionID,
      prompt: Prompt.make({ text: "Slow but healthy" }),
      resume: false,
    })
    const completeEvents = [
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: "text-slow" }),
      LLMEvent.textDelta({ id: "text-slow", text: "Complete" }),
      LLMEvent.textEnd({ id: "text-slow" }),
      LLMEvent.stepFinish({ index: 0, reason: "stop" }),
      LLMEvent.finish({ reason: "stop" }),
    ]
    responseStream = Stream.fromIterable(completeEvents).pipe(Stream.tap(() => Effect.sleep("150 millis")))
    const runner = yield* SessionRunner.Service
    const start = Date.now()
    yield* runner.run({ sessionID, force: true })
    const elapsed = Date.now() - start
    console.log(`[SLOW] healthy slow stream completed; elapsed=${elapsed}ms`)
    expect(elapsed).toBeLessThan(3000)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: "Slow but healthy" },
      {
        type: "assistant",
        finish: "stop",
        content: [{ type: "text", text: "Complete" }],
      },
    ])
  }),
)

it.live("ABSOLUTE: the absolute timeout cuts an active stream that exceeds the turn budget", () =>
  Effect.gen(function* () {
    yield* setup
    ProviderWatchdogConfig.idle = "400 millis"
    ProviderWatchdogConfig.absolute = "1000 millis"
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Trickle forever" }), resume: false })
    // Active stream: emits a delta every ~100ms (< idle 400ms) and never finishes.
    // idle can never fire here; only the absolute budget can cut it.
    responseStream = Stream.concat(
      Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-abs-active" }),
      ]),
      Stream.make(LLMEvent.textDelta({ id: "text-abs-active", text: "." })).pipe(
        Stream.tap(() => Effect.sleep("100 millis")),
        Stream.forever,
      ),
    )
    const runner = yield* SessionRunner.Service
    const start = Date.now()
    const exit = yield* runner.run({ sessionID, force: true }).pipe(Effect.exit)
    const elapsed = Date.now() - start
    console.log(`[ABS-ACTIVE] absolute cut active stream; exit=${exit._tag} elapsed=${elapsed}ms`)
    expect(Exit.isFailure(exit)).toBe(true)
    // elapsed near the absolute budget (1000ms), well past idle (400ms): proves absolute fired, not idle
    expect(elapsed).toBeGreaterThan(800)
    expect(elapsed).toBeLessThan(1600)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: "Trickle forever" },
      {
        type: "assistant",
        finish: "error",
        error: { message: expect.stringContaining("absolute timeout") },
      },
    ])
  }),
)

it.live("ABSOLUTE: with idle off, the absolute timeout still terminates a stalled stream", () =>
  Effect.gen(function* () {
    yield* setup
    ProviderWatchdogConfig.idle = undefined
    ProviderWatchdogConfig.absolute = "800 millis"
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Stall with idle off" }), resume: false })
    // idle is OFF; the only thing that can terminate the stall is the absolute budget.
    responseStream = Stream.concat(
      Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-abs-stall" }),
        LLMEvent.textDelta({ id: "text-abs-stall", text: "Partial" }),
      ]),
      Stream.never,
    )
    const runner = yield* SessionRunner.Service
    const start = Date.now()
    const exit = yield* runner.run({ sessionID, force: true }).pipe(Effect.exit)
    const elapsed = Date.now() - start
    console.log(`[ABS-STALL] absolute cut stalled stream (idle off); exit=${exit._tag} elapsed=${elapsed}ms`)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(elapsed).toBeGreaterThan(600)
    expect(elapsed).toBeLessThan(1500)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: "Stall with idle off" },
      {
        type: "assistant",
        finish: "error",
        error: { message: expect.stringContaining("absolute timeout") },
      },
    ])
  }),
)
