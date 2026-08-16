import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  ProviderInternalReason,
  SystemPart,
  TransportReason,
  isContextOverflowFailure,
  type Model,
  type ProviderErrorEvent,
} from "@ranex/llm"

const WATCHDOG_IDLE_KIND = "watchdog-idle"
const WATCHDOG_ABSOLUTE_KIND = "watchdog-absolute"
// One recovery is enough to repair a truncated call while guaranteeing a model
// that repeatedly emits malformed arguments cannot consume an unbounded turn.
const MAX_INVALID_TOOL_ARGUMENT_RECOVERIES = 1
import { Cause, Clock, DateTime, Effect, Exit, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { ActiveModel } from "../../system-context/active-model"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionReconcile } from "../reconcile"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { ProviderWatchdog } from "./provider-watchdog"
import { ProviderRetryPolicy } from "./provider-retry"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { SessionTurnLLM } from "./turn-llm"
import { SessionTable } from "../sql"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [x] Bound provider retries.
 *   - [ ] Bound repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@ranex/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * - [x] Recover durable continuation with an explicit bounded retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const turnLLM = yield* SessionTurnLLM.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const providerRetry = yield* ProviderRetryPolicy.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const providerWatchdog = yield* ProviderWatchdog.Service
    const db = (yield* Database.Service).db
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    // Per-session serialization of interrupted-tool reconciliation. The single
    // reachable TOCTOU surface is reconcile()-vs-run(): both call this, both can
    // read a tool as `running` and double-publish. run()-vs-run() is impossible
    // by construction (the SessionRunCoordinator same-session join contract).
    const sessionLocks = new Map<SessionSchema.ID, Semaphore.Semaphore>()
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      let semaphore = sessionLocks.get(sessionID)
      if (semaphore === undefined) {
        semaphore = Semaphore.makeUnsafe(1)
        sessionLocks.set(sessionID, semaphore)
      }
      yield* semaphore.withPermit(SessionReconcile.reconcileInterruptedTools({ events, store, sessionID }))
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    class RetryTurnError extends Error {
      constructor(
        readonly attempt: number,
        readonly error: LLMError,
        readonly decision: Extract<ProviderRetryPolicy.Decision, { readonly _tag: "Retry" }>,
        readonly cumulativeDelay: number,
        readonly windowStartedAt: number,
      ) {
        super()
      }
    }

    class FailoverTurnError extends Error {
      constructor(
        readonly error: LLMError,
        readonly from: ModelV2.Ref,
        readonly failAssistant: () => Effect.Effect<void>,
      ) {
        super()
      }
    }

    type FailoverState = {
      /** A failover stays selected for the active drain's continuation turns. */
      readonly model: ModelV2.Ref | undefined
      /** Entries tried in this drain cannot be retried until it settles. */
      readonly used: Set<string>
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const loadSystemContext = (agent: AgentV2.Selection, model: Model) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map((contexts) => SystemContext.combine([...contexts, ActiveModel.activeModel(model)])))

    const failoverSettings = Effect.fn("SessionRunner.failoverSettings")(function* () {
      return Config.documentSlots(yield* config.entries(), "provider_failover")
        .reduce<{ readonly chain: readonly string[]; readonly on_watchdog: boolean }>(
          (result, current) => ({
            chain: current.chain ?? result.chain,
            on_watchdog: current.on_watchdog ?? result.on_watchdog,
          }),
          { chain: [], on_watchdog: false },
        )
    })

    const modelRef = (model: Model, session: SessionSchema.Info): ModelV2.Ref => ({
      id: ModelV2.ID.make(model.id),
      providerID: ProviderV2.ID.make(model.provider),
      ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
    })

    const modelKey = (model: ModelV2.Ref) => `${model.providerID}/${model.id}`
    const isWatchdogFailure = (error: LLMError) =>
      error.reason._tag === "Transport" &&
      (error.reason.kind === WATCHDOG_IDLE_KIND || error.reason.kind === WATCHDOG_ABSOLUTE_KIND)
    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      attempt: number,
      recoveryAttempts: number,
      allowOverflowRecovery: boolean,
      failover: FailoverState,
      resolvedModel?: Model,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      let currentStep = step
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      const watchdog = yield* providerWatchdog.settings()
      const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
      const agent = yield* agents.select(session.agent)
      const model = resolvedModel ?? (yield* models.resolve(session, failover.model))
      const turnSystemContext = loadSystemContext(agent, model)
      const initialized = yield* SessionContextEpoch.initialize(db, turnSystemContext, session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      const system = initialized ?? (yield* SessionContextEpoch.prepare(db, events, turnSystemContext, session.id))
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep ? undefined : yield* tools.materialize(agent.info?.permissions)
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const request = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        system: [agent.info?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [...toLLMMessages(context, model), ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      const startSnapshot = yield* snapshots.capture()
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: modelRef(model, session),
        snapshot: startSnapshot,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (
        event: LLMEvent,
        outputPaths: ReadonlyArray<string> = [],
        outputRefs: ReadonlyArray<import("@ranex/schema/managed-output").ManagedOutput.ID> = [],
      ) => withPublication(publisher.publish(event, outputPaths, outputRefs))
      // Commit a visible dispatch marker before the provider stream can be constructed
      // or consumed. A crash in that window must never look like an idle Session.
      yield* withPublication(publisher.startAssistant())
      let overflowFailure: ProviderErrorEvent | undefined
      let recoveredInvalidToolArguments = false
      const idleError = new LLMError({
        module: "SessionRunner",
        method: "stream",
        reason: new TransportReason({ message: "Provider stream idle timeout", kind: WATCHDOG_IDLE_KIND }),
      })
      const idleDuration = watchdog.idle
      // Idle measures inter-chunk silence only, NOT time-to-first-token. The deadline starts
      // only after the first chunk arrives: the first pull runs untimed (a slow first token —
      // reasoning / extended thinking — is bounded by the absolute budget), then every
      // subsequent pull is raced against the idle deadline. Built on Stream.toPull/fromPull
      // because Stream.peel + Sink.head drops the chunk remainder in this Effect version.
      const idleWatched =
        idleDuration !== undefined
          ? Stream.fromPull(
              Effect.gen(function* () {
                const pull = yield* Stream.toPull(turnLLM.stream(request))
                let first = true
                return Effect.gen(function* () {
                  if (first) {
                    first = false
                    return yield* pull
                  }
                  return yield* Effect.raceFirst(
                    pull,
                    Effect.sleep(idleDuration).pipe(Effect.andThen(Effect.fail(idleError))),
                  )
                })
              }),
            )
          : turnLLM.stream(request)
      const providerStream = idleWatched.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantProducedOutput()) {
                overflowFailure = event
                return
              }
              if (event.retryable && !publisher.hasAssistantProducedOutput())
                return yield* Effect.fail(
                  new LLMError({
                    module: "SessionRunner",
                    method: "stream",
                    reason: new ProviderInternalReason({ message: event.message, status: 503 }),
                  }),
                )
            }
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                    settlement.outputRefs ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const providerTurn =
            watchdog.absolute !== undefined
              ? Effect.raceFirst(
                  restore(providerStream),
                  restore(
                    Effect.sleep(watchdog.absolute).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new LLMError({
                            module: "SessionRunner",
                            method: "stream",
                            reason: new TransportReason({
                              message: "Provider turn absolute timeout",
                              kind: WATCHDOG_ABSOLUTE_KIND,
                            }),
                          }),
                        ),
                      ),
                    ),
                  ),
                )
              : providerStream
          const stream = yield* restore(providerTurn).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            allowOverflowRecovery &&
            !publisher.hasAssistantProducedOutput() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(compaction.compactAfterOverflow({ sessionID: session.id, entries, model, request })))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          const assistantProducedOutput = publisher.hasAssistantProducedOutput()
          const interrupted = stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)
          const invalidToolArguments =
            llmFailure?.reason._tag === "InvalidProviderOutput" &&
            llmFailure.reason.kind === "invalid-tool-arguments" &&
            llmFailure.reason.toolName !== undefined &&
            llmFailure.reason.toolCallID !== undefined
              ? {
                  toolName: llmFailure.reason.toolName,
                  toolCallID: llmFailure.reason.toolCallID,
                  finishReason: llmFailure.reason.finishReason,
                }
              : undefined
          if (
            invalidToolArguments &&
            recoveryAttempts < MAX_INVALID_TOOL_ARGUMENT_RECOVERIES &&
            !publisher.hasCalledTools()
          ) {
            recoveredInvalidToolArguments = true
            needsContinuation = true
            const finishReason = invalidToolArguments.finishReason
            yield* withPublication(
              publisher.recoverUncalledTool({
                id: invalidToolArguments.toolCallID,
                name: invalidToolArguments.toolName,
                message:
                  finishReason === "length"
                    ? `Tool arguments were incomplete because the provider finished with ${finishReason}; resend ${invalidToolArguments.toolName} with valid JSON.`
                    : `Tool arguments were invalid JSON; resend ${invalidToolArguments.toolName} with valid JSON.`,
              }),
            )
            yield* withPublication(
              events.publish(SessionEvent.Tool.ArgumentsRecovered, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                tool: invalidToolArguments.toolName,
                reason: "invalid-tool-arguments-recovered",
                finishReason,
              }),
            )
          }
          if (llmFailure && !assistantProducedOutput && stream._tag === "Failure" && !interrupted) {
            // EventV2 commits the durable Retried event and this projection in the
            // same transaction, so a committed retry event always has its budget
            // columns available to a later drain.
            const persisted = yield* db
              .select({
                cumulative_delay_ms: SessionTable.retry_cumulative_delay_ms,
                window_started_at: SessionTable.retry_window_started_at,
              })
              .from(SessionTable)
              .where(eq(SessionTable.id, session.id))
              .get()
              .pipe(Effect.orDie)
            const now = yield* Clock.currentTimeMillis
            const decision = yield* providerRetry.decide({
              error: llmFailure,
              completed_attempt: attempt + 1,
              assistant_started: assistantProducedOutput,
              interrupted,
              cumulative_delay_ms: persisted?.cumulative_delay_ms ?? 0,
              window_started_at: persisted?.window_started_at ?? now,
            })
            const failoverConfig = yield* failoverSettings()
            const failAssistant = () =>
              Effect.gen(function* () {
                yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
                yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
              })
            // Failover can amplify a provider incident with a fresh retry budget
            // for every configured model, so enter only after this attempt is safe
            // to abandon without duplicating output or tool work.
            if (failoverConfig.chain.length > 0 && isWatchdogFailure(llmFailure) && failoverConfig.on_watchdog)
              return yield* Effect.die(new FailoverTurnError(llmFailure, modelRef(model, session), failAssistant))
            if (decision._tag === "Retry")
              return yield* Effect.die(
                new RetryTurnError(
                  attempt,
                  llmFailure,
                  decision,
                  persisted?.cumulative_delay_ms ?? 0,
                  persisted?.window_started_at ?? now,
                ),
              )
            if (
              failoverConfig.chain.length > 0 &&
              !isWatchdogFailure(llmFailure) &&
              ProviderRetryPolicy.classify(llmFailure) !== undefined &&
              decision._tag === "Stop"
            )
              return yield* Effect.die(new FailoverTurnError(llmFailure, modelRef(model, session), failAssistant))
          }
          if (llmFailure && !recoveredInvalidToolArguments && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          // A failed provider turn must not wait forever for a tool that ignored the
          // provider watchdog. Keep every healthy or unbudgeted settlement await
          // unchanged; only a failed, absolutely-bounded turn gains this second bound.
          const settled = yield* Effect.gen(function* () {
            if (stream._tag !== "Failure" || watchdog.absolute === undefined)
              return yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
            const raced = yield* Effect.raceFirst(
              restore(awaitToolFibers(toolFibers)).pipe(Effect.exit),
              restore(Effect.sleep(watchdog.absolute)).pipe(Effect.as(null)),
            )
            if (raced === null) {
              yield* FiberSet.clear(toolFibers)
              yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
              return Exit.succeed(undefined)
            }
            return raced
          })
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                cost: 0,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
          }
          if (
            stream._tag === "Success" &&
            !stepSettlement &&
            !publisher.hasProviderError() &&
            !publisher.hasAssistantProducedOutput()
          )
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: "stop",
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              }),
            )
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (recoveredInvalidToolArguments)
            return {
              needsContinuation: true,
              step: currentStep,
              recoveryAttempts: recoveryAttempts + 1,
            }
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          return {
            needsContinuation: !publisher.hasProviderError() && needsContinuation,
            step: currentStep,
            recoveryAttempts,
          }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      attempt: number,
      recoveryAttempts: number,
      failover: FailoverState,
      resolvedModel?: Model,
    ) => Effect.Effect<
      { readonly needsContinuation: boolean; readonly step: number; readonly recoveryAttempts: number },
      RunError
    >

    const retryTurn = (
      sessionID: SessionSchema.ID,
      defect: RetryTurnError,
      reenter: (attempt: number) => ReturnType<RunTurn>,
    ) =>
      Effect.gen(function* () {
        const reason = defect.error.reason
        const statusCode =
          "status" in reason
            ? reason.status
            : reason._tag === "RateLimit"
              ? (reason.http?.response?.status ?? 429)
              : "http" in reason
                ? reason.http?.response?.status
                : undefined
        yield* events.publish(SessionEvent.Retried, {
          sessionID,
          timestamp: yield* DateTime.now,
          attempt: defect.attempt,
          retry_class: defect.decision.class,
          delay_ms: defect.decision.delay_ms,
          cumulative_delay_ms: defect.cumulativeDelay + defect.decision.delay_ms,
          window_started_at: defect.windowStartedAt,
          remaining_delay_ms: defect.decision.remaining_delay_ms,
          error: {
            message: defect.error.message,
            statusCode,
            isRetryable: true,
          },
        })
        yield* Effect.sleep(defect.decision.delay_ms)
        return yield* reenter(defect.attempt + 1)
      })

    const failoverTurn = (
      sessionID: SessionSchema.ID,
      step: number,
      attempt: number,
      recoveryAttempts: number,
      defect: FailoverTurnError,
      failover: FailoverState,
      allowOverflowRecovery: boolean,
    ) =>
      Effect.gen(function* () {
        const session = yield* getSession(sessionID)
        const settings = yield* failoverSettings()
        for (const entry of settings.chain) {
          const parsed = ModelV2.parse(entry)
          const to: ModelV2.Ref = {
            id: parsed.modelID,
            providerID: parsed.providerID,
          }
          const key = modelKey(to)
          if (key === modelKey(defect.from) || failover.used.has(key)) continue
          failover.used.add(key)
          const resolution = yield* models.resolve(session, to).pipe(
            Effect.match({
              onFailure: (error) => ({ error }),
              onSuccess: (model) => ({ model }),
            }),
          )
          if ("error" in resolution) {
            yield* Effect.logWarning(`Skipping unavailable provider failover model ${entry}: ${resolution.error.message}`)
            continue
          }
          // A crash after this record but before fallback completion stays
          // provider_in_flight during recovery; do not replay a potentially
          // dispatched fallback provider turn automatically.
          yield* events.publish(SessionEvent.ModelFailedOver, {
            sessionID,
            timestamp: yield* DateTime.now,
            from: defect.from,
            to,
            error: { message: defect.error.message },
          })
          const next = { ...failover, model: to }
          if (allowOverflowRecovery)
            return yield* runTurn(sessionID, undefined, step, 0, recoveryAttempts, next, resolution.model)
          return yield* runAfterOverflowCompaction(sessionID, undefined, step, 0, recoveryAttempts, next, resolution.model)
        }
        yield* defect.failAssistant()
        return yield* Effect.fail(defect.error)
      })

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(
      function* (sessionID, promotion, step, attempt, recoveryAttempts, failover, resolvedModel) {
        return yield* runTurnAttempt(
          sessionID,
          promotion,
          step,
          attempt,
          recoveryAttempts,
          false,
          failover,
          resolvedModel,
        ).pipe(
          Effect.catchDefect(
            Effect.fnUntraced(function* (defect) {
              if (defect instanceof RetryTurnError)
                return yield* retryTurn(sessionID, defect, (nextAttempt) =>
                  runAfterOverflowCompaction(sessionID, undefined, step, nextAttempt, recoveryAttempts, failover),
                )
              if (defect instanceof FailoverTurnError)
                return yield* failoverTurn(
                  sessionID,
                  step,
                  attempt,
                  recoveryAttempts,
                  defect,
                  failover,
                  false,
                )
              if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
              if (defect.transition._tag === "ContinueAfterOverflowCompaction")
                return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
              yield* Effect.yieldNow
              return yield* runAfterOverflowCompaction(
                sessionID,
                undefined,
                defect.transition.step,
                attempt,
                recoveryAttempts,
                failover,
                resolvedModel,
              )
            }),
          ),
        )
      },
    )

    const runTurn: RunTurn = Effect.fnUntraced(function* (
      sessionID,
      promotion,
      step,
      attempt,
      recoveryAttempts,
      failover,
      resolvedModel,
    ) {
      return yield* runTurnAttempt(
        sessionID,
        promotion,
        step,
        attempt,
        recoveryAttempts,
        true,
        failover,
        resolvedModel,
      ).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (defect instanceof RetryTurnError)
              return yield* retryTurn(sessionID, defect, (nextAttempt) =>
                  runTurn(sessionID, undefined, step, nextAttempt, recoveryAttempts, failover),
                )
              if (defect instanceof FailoverTurnError)
                return yield* failoverTurn(
                  sessionID,
                  step,
                  attempt,
                  recoveryAttempts,
                  defect,
                  failover,
                  true,
                )
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(
                sessionID,
                undefined,
                defect.transition.step,
                attempt,
                recoveryAttempts,
                failover,
              )
            return yield* runTurn(
              sessionID,
              undefined,
              defect.transition.step,
              attempt,
              recoveryAttempts,
              failover,
              resolvedModel,
            )
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      // Reconcile tools stranded by a prior crash BEFORE the eligible-input guard.
      // A crash with an empty inbox never re-enters run() through the inbox, so
      // reconciliation must fire here regardless of pending work. It only touches
      // projected tool context, never SessionInput, so the guard is unchanged.
      yield* failInterruptedTools(input.sessionID)
      const persistedRetry = yield* db
        .select({
          attempt: SessionTable.retry_attempt,
          next_attempt_at: SessionTable.retry_next_attempt_at,
          window_started_at: SessionTable.retry_window_started_at,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      const retryAttempt = persistedRetry?.attempt ?? undefined
      const retryNextAttemptAt = persistedRetry?.next_attempt_at ?? undefined
      if (retryAttempt !== undefined && retryNextAttemptAt !== undefined) {
        const now = yield* Clock.currentTimeMillis
        const settings = yield* providerRetry.settings()
        if (
          persistedRetry?.window_started_at !== null &&
          persistedRetry?.window_started_at !== undefined &&
          now - persistedRetry.window_started_at >= settings.max_elapsed_ms
        ) {
          yield* db
            .update(SessionTable)
            .set({
              retry_attempt: null,
              retry_next_attempt_at: null,
              retry_cumulative_delay_ms: null,
              retry_window_started_at: null,
            })
            .where(eq(SessionTable.id, input.sessionID))
            .run()
            .pipe(Effect.orDie)
          return
        }
        yield* Effect.sleep(Math.max(0, retryNextAttemptAt - now))
      }
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue && retryAttempt === undefined) return
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue || retryAttempt !== undefined
      let attempt = retryAttempt === undefined ? 0 : retryAttempt + 1
      while (shouldRun) {
        // A fallback remains active for this drain, including tool continuations.
        // Starting the next queued input is a new run and returns to configured selection.
        const failover: FailoverState = { model: undefined, used: new Set() }
        let needsContinuation = true
        let step = 1
        let recoveryAttempts = 0
        while (needsContinuation) {
          const exit = yield* runTurn(input.sessionID, promotion, step, attempt, recoveryAttempts, failover).pipe(Effect.exit)
          if (Exit.isFailure(exit) && (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))) return yield* exit
          yield* db
            .update(SessionTable)
            .set({
              retry_attempt: null,
              retry_next_attempt_at: null,
              retry_cumulative_delay_ms: null,
              retry_window_started_at: null,
            })
            .where(eq(SessionTable.id, input.sessionID))
            .run()
            .pipe(Effect.orDie)
          const result = yield* exit
          needsContinuation = result.needsContinuation
          step = result.step + 1
          recoveryAttempts = result.recoveryAttempts
          attempt = 0
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
      }
    })

    // Reconciles interrupted tools for one session without scheduling a provider
    // turn. The startup sweep (SessionReconcile.sweepNode) calls the shared logic
    // over all sessions at process boot; this capability is the explicit entrypoint.
    const reconcile = Effect.fn("SessionRunner.reconcile")(function* (sessionID: SessionSchema.ID) {
      yield* failInterruptedTools(sessionID)
    })

    return Service.of({
      run,
      reconcile,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    SessionTurnLLM.node,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    ProviderWatchdog.node,
    ProviderRetryPolicy.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
  ],
})
