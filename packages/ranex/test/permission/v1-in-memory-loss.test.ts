import { PermissionV1 } from "@ranex/core/v1/permission"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@ranex/core/cross-spawn-spawner"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, Question.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

describe("V1 in-memory wait isolation", () => {
  it.instance(
    "loses a pending permission when its instance is torn down",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const store = yield* InstanceStore.Service
        const permission = yield* Permission.Service
        const fiber = yield* permission
          .ask({
            id: PermissionV1.ID.make("per_in_memory"),
            sessionID: SessionID.make("ses_in_memory"),
            permission: "bash",
            patterns: ["pwd"],
            metadata: {},
            always: [],
            ruleset: [],
          })
          .pipe(Effect.forkScoped)

        expect(
          yield* pollWithTimeout(
            permission.list().pipe(Effect.map((pending) => (pending.length === 1 ? pending : undefined))),
            "permission never became pending",
          ),
        ).toHaveLength(1)

        yield* store.load({ directory: test.directory }).pipe(Effect.flatMap((ctx) => store.dispose(ctx)))

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)

        const pending = yield* store.provide(
          { directory: test.directory },
          Permission.Service.use((service) => service.list()),
        )
        expect(pending).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "loses a pending question when its instance is torn down",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const store = yield* InstanceStore.Service
        const question = yield* Question.Service
        const fiber = yield* question
          .ask({
            sessionID: SessionID.make("ses_in_memory"),
            questions: [
              {
                question: "Does this survive teardown?",
                header: "In-memory",
                options: [{ label: "No", description: "V1 waits are not durable" }],
              },
            ],
          })
          .pipe(Effect.forkScoped)

        expect(
          yield* pollWithTimeout(
            question.list().pipe(Effect.map((pending) => (pending.length === 1 ? pending : undefined))),
            "question never became pending",
          ),
        ).toHaveLength(1)

        yield* store.load({ directory: test.directory }).pipe(Effect.flatMap((ctx) => store.dispose(ctx)))

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.RejectedError)

        const pending = yield* store.provide(
          { directory: test.directory },
          Question.Service.use((service) => service.list()),
        )
        expect(pending).toEqual([])
      }),
    { git: true },
  )
})
