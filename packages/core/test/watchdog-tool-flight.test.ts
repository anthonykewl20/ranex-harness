/**
 * SLICE-012 criterion 6 — provider watchdog with a tool call in flight.
 *
 * The SLICE-011 claim-1 prototype (79093b3064) proved the idle + absolute
 * watchdog using NO-tool fixtures. Its exit record says so. This file covers
 * the gap and pins the observable the amended criterion names.
 *
 * The defect (pre-fix): the cleanup at runner/llm.ts:333 gated on
 * `Cause.hasInterrupts(stream.cause)`, a watchdog `Stream.fail(LLMError)` is an
 * error not an interrupt, so dispatched tool fibers were not cleared and :334
 * (`awaitToolFibers`) joined the still-running tool fiber forever. The
 * watchdog's own failure path at :330 calls `failUnsettledTools(..., true)`
 * with `hostedOnly`, which skipped local tools, so the in-flight tool was not
 * recorded interrupted either.
 *
 * The fix bounds the settlement await by the configured turn budget
 * (runner/llm.ts:334): with no budget the await is byte-identical to before, so
 * a plain provider error still lets a started tool finish (the at-most-once
 * contract, covered by session-runner.test.ts "awaits started local tools
 * before surfacing provider stream failure"); with a budget, a stuck tool is
 * cleared and recorded interrupted and the run reaches a terminal state.
 *
 * The observable is specific: does the tool fiber terminate, and is the tool
 * recorded interrupted? The stall lives inside the watched stream
 * (`Stream.fromIterable([stepStart, toolCall]) ++ Stream.never` — the
 * `Stream.never` is what `Stream.timeoutOrElse` guards), which is why the
 * watchdog fires at all.
 *
 * Time is driven by `TestClock` (control 5), not a wall clock. The tool fiber
 * blocks on a `Deferred`, not on time, so advancing the clock fires the
 * watchdog but cannot release the tool — which is exactly the stranding
 * condition under test.
 *
 * TOOL-SLOW / TOOL-ABS assert the CORRECT behaviour (fiber terminated, tool
 * recorded interrupted, run at a terminal state) and go RED if the settlement
 * bound is reverted to the unconditional await (verified by reverting
 * runner/llm.ts:334). TOOL-FAST is the contrast: a tool that settles before the
 * watchdog is recorded completed and the run still terminates.
 */
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
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
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

/**
 * `gated` blocks on `toolGate`. `gatedStarted` fires once the tool fiber is
 * genuinely in flight (so the test knows the watchdog will fire with a tool
 * dispatched). `gatedTerminated` flips on ANY fiber exit — natural completion
 * or interruption — via `Effect.ensuring`, so it observes whether the tool
 * fiber terminated at all. The criterion-6 observable is exactly this pair:
 * does the fiber terminate (`gatedTerminated`) and is the tool recorded
 * interrupted (projected status "error"), with the run reaching a terminal
 * state (`active === false`).
 */
let toolGate: Deferred.Deferred<void> | undefined
let gatedStarted: Deferred.Deferred<void> | undefined
let echoStarted: Deferred.Deferred<void> | undefined
let gatedBodyEntered = false
let gatedTerminated = false
const tools = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }) =>
          Effect.gen(function* () {
            if (echoStarted) yield* Deferred.succeed(echoStarted, undefined)
            return { text }
          }),
      }),
      gated: Tool.make({
        description: "Block on a gate to simulate a long-running tool",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }) =>
          Effect.gen(function* () {
            gatedBodyEntered = true
            if (gatedStarted) yield* Deferred.succeed(gatedStarted, undefined)
            if (toolGate) yield* Deferred.await(toolGate)
            return { text }
          }).pipe(Effect.ensuring(Effect.sync(() => { gatedTerminated = true }))),
      }),
    }),
  ),
)
const toolsNode = makeLocationNode({ name: "test/watchdog-tool-flight", layer: tools, deps: [ToolRegistry.node] })
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
      toolsNode,
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
  toolGate = undefined
  gatedStarted = undefined
  echoStarted = undefined
  gatedBodyEntered = false
  gatedTerminated = false
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

const toolState = (context: ReadonlyArray<unknown>) => {
  const assistant = assistantEntry(context)
  const content =
    (assistant?.content as ReadonlyArray<{ type: string; id: string; state?: { status: string; error?: { message: string } } }> | undefined) ?? []
  const tool = content.find((part) => part.type === "tool")
  return tool?.state
}

const assistantOutcome = (context: ReadonlyArray<unknown>) => {
  const assistant = assistantEntry(context)
  if (!assistant) return undefined
  return { finish: assistant.finish as string | undefined, error: (assistant.error as { message?: string } | undefined)?.message }
}

const assistantEntry = (context: ReadonlyArray<unknown>) =>
  context.find((entry): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null && (entry as { type: string }).type === "assistant",
  )

/**
 * Non-blocking fiber-outcome probe. `Fiber.status` is not exported in
 * effect@4.0.0-beta.83, so we fork `Fiber.await` and race it against a tiny
 * `TestClock`-driven sleep: the fork resolves only when the target fiber
 * terminates; if the sleep wins the target is still in flight. Neither branch
 * interrupts the target. Returns the Exit, or `undefined` if still running.
 */
const pollNonBlocking = <A, E>(fiber: Fiber.Fiber<A, E>): Effect.Effect<Exit.Exit<A, E> | undefined> =>
  Effect.gen(function* () {
    const probed = yield* Effect.forkChild(
      Effect.raceFirst(
        Fiber.await(fiber).pipe(Effect.map((exit) => ({ tag: "done" as const, exit }))),
        Effect.sleep("1 millis").pipe(Effect.as({ tag: "pending" as const })),
      ),
    )
    yield* TestClock.adjust("1 millis")
    const result = yield* Fiber.join(probed)
    return result.tag === "done" ? (result.exit as Exit.Exit<A, E>) : undefined
  })

it.effect("TOOL-FAST: a tool that settles before the watchdog is recorded completed (contrast case)", () =>
  Effect.gen(function* () {
    yield* setup
    ProviderWatchdogConfig.idle = "400 millis"
    ProviderWatchdogConfig.absolute = "3000 millis"
    echoStarted = yield* Deferred.make<void>()
    const session = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service
    yield* session.prompt({
      sessionID,
      prompt: Prompt.make({ text: "Call echo then stall" }),
      resume: false,
    })
    responseStream = Stream.concat(
      Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hi" } }),
      ]),
      Stream.never,
    )
    const resumeFiber = yield* Effect.forkChild(execution.resume(sessionID))
    yield* Deferred.await(echoStarted)
    yield* TestClock.adjust("500 millis")
    yield* Effect.yieldNow
    const exit = yield* Fiber.join(resumeFiber).pipe(Effect.exit)
    const stillActive = (yield* execution.active).has(sessionID)
    const state = toolState(yield* session.context(sessionID))
    console.log(`[TOOL-FAST] exit=${exit._tag} toolStatus=${state?.status} active=${stillActive}`)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(state?.status).toBe("completed")
    expect(stillActive).toBe(false)
  }),
)

it.effect(
  "TOOL-SLOW (idle): the watchdog fires and a stuck tool is terminated and recorded interrupted, run reaches terminal state",
  () =>
    Effect.gen(function* () {
      yield* setup
      ProviderWatchdogConfig.idle = "400 millis"
      ProviderWatchdogConfig.absolute = "3000 millis"
      toolGate = yield* Deferred.make<void>()
      gatedStarted = yield* Deferred.make<void>()
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Call gated then stall" }),
        resume: false,
      })
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-gated", name: "gated", input: { text: "stall" } }),
        ]),
        Stream.never,
      )
      const resumeFiber = yield* Effect.forkChild(execution.resume(sessionID))
      yield* Deferred.await(gatedStarted)
      yield* TestClock.adjust("500 millis")
      yield* Effect.yieldNow
      yield* TestClock.adjust("3000 millis")
      yield* Effect.yieldNow
      const stillActive = (yield* execution.active).has(sessionID)
      const context = yield* session.context(sessionID)
      const state = toolState(context)
      const outcome = assistantOutcome(context)
      const resumeDone = (yield* pollNonBlocking(resumeFiber)) !== undefined
      console.log(
        `[TOOL-SLOW] watchdogFired=${outcome?.finish === "error" && outcome?.error?.includes("idle timeout")} gatedTerminated=${gatedTerminated} toolStatus=${state?.status} toolError=${state?.error?.message} active=${stillActive} resumeDone=${resumeDone}`,
      )
      expect(gatedBodyEntered).toBe(true)
      expect(outcome?.finish).toBe("error")
      expect(outcome?.error).toContain("idle timeout")
      expect(gatedTerminated).toBe(true)
      expect(state?.status).toBe("error")
      expect(state?.error?.message).toContain("interrupted")
      expect(stillActive).toBe(false)
      expect(resumeDone).toBe(true)
    }),
)

it.effect(
  "TOOL-ABS (absolute, idle off): the absolute watchdog fires and a stuck tool is terminated and recorded interrupted, run reaches terminal state",
  () =>
    Effect.gen(function* () {
      yield* setup
      ProviderWatchdogConfig.idle = undefined
      ProviderWatchdogConfig.absolute = "800 millis"
      toolGate = yield* Deferred.make<void>()
      gatedStarted = yield* Deferred.make<void>()
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Call gated then stall (absolute)" }),
        resume: false,
      })
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-gated-abs", name: "gated", input: { text: "stall-abs" } }),
        ]),
        Stream.never,
      )
      const resumeFiber = yield* Effect.forkChild(execution.resume(sessionID))
      yield* Deferred.await(gatedStarted)
      yield* TestClock.adjust("900 millis")
      yield* Effect.yieldNow
      yield* TestClock.adjust("800 millis")
      yield* Effect.yieldNow
      const stillActive = (yield* execution.active).has(sessionID)
      const context = yield* session.context(sessionID)
      const state = toolState(context)
      const outcome = assistantOutcome(context)
      const resumeDone = (yield* pollNonBlocking(resumeFiber)) !== undefined
      console.log(
        `[TOOL-ABS] watchdogFired=${outcome?.finish === "error" && outcome?.error?.includes("absolute timeout")} gatedTerminated=${gatedTerminated} toolStatus=${state?.status} toolError=${state?.error?.message} active=${stillActive} resumeDone=${resumeDone}`,
      )
      expect(outcome?.finish).toBe("error")
      expect(outcome?.error).toContain("absolute timeout")
      expect(gatedTerminated).toBe(true)
      expect(state?.status).toBe("error")
      expect(state?.error?.message).toContain("interrupted")
      expect(stillActive).toBe(false)
      expect(resumeDone).toBe(true)
    }),
)
