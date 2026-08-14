import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { FSUtil } from "@ranex/core/fs-util"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { WorktreeAdapter } from "../../src/control-plane/adapters/worktree"
import type { WorkspaceInfo } from "../../src/control-plane/types"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

/**
 * The public Worktree.Info schema grows baseSha in this slice. Keep this test
 * boundary explicit so the frozen contract can be compiled before production
 * admits the field.
 */
type PinnedInfo = Worktree.Info & { readonly baseSha: string }

const layer = LayerNode.compile(
  LayerNode.group([Worktree.node, FSUtil.node, Git.node, EventV2Bridge.node]),
  [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
)
const it = testEffect(layer)

const failingStoreLayer = LayerNode.compile(LayerNode.group([Worktree.node, FSUtil.node, Git.node]), [
  [
    InstanceStore.node,
    Layer.mock(InstanceStore.Service, {
      load: () => Effect.fail(new Error("simulated InstanceStore.load failure")) as never,
    }),
  ],
])
const failingStoreIt = testEffect(failingStoreLayer)

const git = Effect.fn("WorktreeProvisioningTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text().trim()
})

const pinnedInfo = Effect.fn("WorktreeProvisioningTest.pinnedInfo")(function* (name: string) {
  const svc = yield* Worktree.Service
  const test = yield* TestInstance
  const info = yield* svc.makeWorktreeInfo({ name })
  const baseSha = yield* git(test.directory, ["rev-parse", "HEAD"])
  return { ...info, baseSha } as PinnedInfo
})

const advancePrimary = Effect.fn("WorktreeProvisioningTest.advancePrimary")(function* () {
  const test = yield* TestInstance
  yield* Effect.promise(() => Bun.write(path.join(test.directory, `advanced-${crypto.randomUUID()}`), "new head\n"))
  yield* git(test.directory, ["add", "."])
  yield* git(test.directory, ["commit", "-m", "advance primary after pin"])
})

const discardWorktree = Effect.fn("WorktreeProvisioningTest.discardWorktree")(function* (directory: string) {
  const test = yield* TestInstance
  const service = yield* Git.Service
  yield* service.run(["worktree", "remove", "--force", directory], { cwd: test.directory })
})

const expectCreateFailure = <R, E>(effect: Effect.Effect<unknown, E, R>, directory: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    yield* discardWorktree(directory)
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(Worktree.CreateFailedError)
    expect((error as { _tag?: string })._tag).toBe("WorktreeCreateFailedError")
  })

const removeIfCreated = (directory: string) =>
  Worktree.Service.use((svc) => svc.remove({ directory }).pipe(Effect.ignore))

describe("Worktree.createFromInfo provisioning (SLICE-020)", () => {
  afterEach(() => disposeAllInstances())

  it.instance(
    "awaits a failed pinned checkout and leaves no ready worktree behind",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const info = yield* pinnedInfo("failed-provisioning")
        const missing = { ...info, baseSha: "f".repeat(40) } as PinnedInfo

        yield* expectCreateFailure(Worktree.Service.use((svc) => svc.createFromInfo(missing)), missing.directory)
        const worktrees = yield* git(test.directory, ["worktree", "list", "--porcelain"])
        expect(worktrees).not.toContain(missing.directory)
      }),
    { git: true },
  )

  it.instance(
    "creates the run worktree on its named branch and pins HEAD before the primary advances",
    () =>
      Effect.gen(function* () {
        const info = yield* pinnedInfo("branch-and-pin")
        yield* advancePrimary()
        const test = yield* TestInstance
        expect(yield* git(test.directory, ["rev-parse", "HEAD"])).not.toBe(info.baseSha)

        const svc = yield* Worktree.Service
        yield* svc.createFromInfo(info)
        const events = yield* EventV2Bridge.Service
        const ready = yield* events.durable({ aggregateID: info.name }).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("2 seconds"),
          Effect.exit,
        )
        if (!Exit.isSuccess(ready)) yield* discardWorktree(info.directory)
        expect(Exit.isSuccess(ready)).toBe(true)
        const branch = yield* git(info.directory, ["symbolic-ref", "--short", "HEAD"])
        const head = yield* git(info.directory, ["rev-parse", "HEAD"])
        if (!info.branch) throw new Error("test requires a branch worktree")
        expect(branch).toBe(info.branch)
        expect(head).toBe(info.baseSha)
      }),
    { git: true },
  )

  it.instance(
    "rejects info without an explicit base SHA instead of silently using HEAD",
    () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const info = yield* svc.makeWorktreeInfo({ name: "missing-base-sha" })

        yield* expectCreateFailure(svc.createFromInfo(info), info.directory)
      }),
    { git: true },
  )

  it.instance(
    "surfaces a pinned reset failure as WorktreeCreateFailedError without hanging",
    () =>
      Effect.gen(function* () {
        const info = yield* pinnedInfo("reset-failure")
        const missingObject = { ...info, baseSha: "e".repeat(40) } as PinnedInfo

        yield* expectCreateFailure(
          Worktree.Service.use((svc) =>
            awaitWithTimeout(svc.createFromInfo(missingObject), "createFromInfo hung while resetting the pinned base", "10 seconds"),
          ),
          missingObject.directory,
        )
      }),
    { git: true },
  )

  failingStoreIt.instance(
    "surfaces InstanceStore.load failure as WorktreeCreateFailedError",
    () =>
      Effect.gen(function* () {
        const info = yield* pinnedInfo("store-load-failure")
        yield* expectCreateFailure(Worktree.Service.use((svc) => svc.createFromInfo(info)), info.directory)
      }),
    { git: true },
  )

  it.instance(
    "rejects a real directory/file branch conflict that candidate generation cannot pre-detect",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const info = yield* pinnedInfo("branch-conflict")
        if (!info.branch) throw new Error("test requires a branch worktree")
        yield* git(test.directory, ["branch", "opencode"])

        yield* expectCreateFailure(Worktree.Service.use((svc) => svc.createFromInfo(info)), info.directory)
        const events = yield* EventV2Bridge.Service
        const failed = yield* events.durable({ aggregateID: info.name }).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("2 seconds"),
          Effect.exit,
        )
        expect(Exit.isSuccess(failed)).toBe(true)
      }),
    { git: true },
  )

  it.instance(
    "starts a never-returning script after provisioning without waiting for it",
    () =>
      Effect.gen(function* () {
        const info = yield* pinnedInfo("non-returning-start")
        const marker = path.join(info.directory, ".ranex-started")
        const svc = yield* Worktree.Service
        const test = yield* TestInstance
        yield* advancePrimary()

        yield* awaitWithTimeout(
          svc.createFromInfo(info, "touch .ranex-started; while :; do sleep 1; done"),
          "createFromInfo waited for the never-returning start script",
          "10 seconds",
        )
        yield* pollWithTimeout(
          Effect.promise(async () => ((await Bun.file(marker).exists()) ? marker : undefined)),
          "start script marker was absent after createFromInfo resolved",
          "10 seconds",
        )
        const primaryHead = yield* git(test.directory, ["rev-parse", "HEAD"])
        const worktreeHead = yield* git(info.directory, ["rev-parse", "HEAD"])
        yield* discardWorktree(info.directory)
        expect(primaryHead).not.toBe(info.baseSha)
        expect(worktreeHead).toBe(info.baseSha)
      }),
    { git: true },
  )

  it.instance(
    "refuses destructive cleaning that would remove node_modules or .env from a target worktree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const info = yield* pinnedInfo("preserve-untracked")
        if (!info.branch) throw new Error("test requires a branch worktree")
        const fs = yield* FSUtil.Service
        yield* git(test.directory, ["worktree", "add", "-b", info.branch, info.directory])
        yield* fs.ensureDir(path.join(info.directory, "node_modules"))
        yield* Effect.promise(() => Bun.write(path.join(info.directory, "node_modules", "x"), "keep"))
        yield* Effect.promise(() => Bun.write(path.join(info.directory, ".env"), "keep"))

        const reset = yield* Effect.exit(Worktree.Service.use((svc) => svc.reset({ directory: info.directory })))
        expect(Exit.isSuccess(reset) || Cause.squash(reset.cause) instanceof Worktree.ResetFailedError).toBe(true)
        expect(yield* fs.exists(path.join(info.directory, "node_modules", "x"))).toBe(true)
        expect(yield* fs.exists(path.join(info.directory, ".env"))).toBe(true)
        yield* removeIfCreated(info.directory)
      }),
    { git: true },
  )

  it.instance(
    "persists ready and failed events under the worktree-name aggregate",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2Bridge.Service
        const readyInfo = yield* pinnedInfo("durable-ready")
        yield* Worktree.Service.use((svc) => svc.createFromInfo(readyInfo))
        const ready = yield* events.durable({ aggregateID: readyInfo.name }).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("2 seconds"),
          Effect.exit,
        )
        if (!Exit.isSuccess(ready)) yield* discardWorktree(readyInfo.directory)
        expect(Exit.isSuccess(ready)).toBe(true)
        if (Exit.isSuccess(ready)) {
          const event = Array.from(ready.value)[0]
          expect(event?.type).toBe(Worktree.Event.Ready.type)
          expect((event?.data as { name?: string } | undefined)?.name).toBe(readyInfo.name)
        }
        yield* removeIfCreated(readyInfo.directory)

        const failedInfo = { ...(yield* pinnedInfo("durable-failed")), baseSha: "0".repeat(40) } as PinnedInfo
        yield* Effect.exit(Worktree.Service.use((svc) => svc.createFromInfo(failedInfo)))
        const failed = yield* events.durable({ aggregateID: failedInfo.name }).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("2 seconds"),
          Effect.exit,
        )
        expect(Exit.isSuccess(failed)).toBe(true)
        if (Exit.isSuccess(failed)) {
          const event = Array.from(failed.value)[0]
          expect(event?.type).toBe(Worktree.Event.Failed.type)
          expect((event?.data as { name?: string } | undefined)?.name).toBe(failedInfo.name)
        }
        yield* removeIfCreated(failedInfo.directory)
      }),
    { git: true },
  )

  it.instance(
    "arbitrates concurrent creates without losing the pinned base or leaving half state",
    () =>
      Effect.gen(function* () {
        const info = yield* pinnedInfo("idempotent-race")
        yield* advancePrimary()
        const svc = yield* Worktree.Service
        const results = yield* Effect.all(
          [svc.createFromInfo(info).pipe(Effect.exit), svc.createFromInfo(info).pipe(Effect.exit)],
          { concurrency: 2 },
        )
        const successes = results.filter(Exit.isSuccess)
        expect(successes.length).toBeGreaterThanOrEqual(1)
        expect(successes.length).toBeLessThanOrEqual(2)
        const events = yield* EventV2Bridge.Service
        const ready = yield* events.durable({ aggregateID: info.name }).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("2 seconds"),
          Effect.exit,
        )
        if (!Exit.isSuccess(ready)) yield* discardWorktree(info.directory)
        expect(Exit.isSuccess(ready)).toBe(true)
        const head = yield* git(info.directory, ["rev-parse", "HEAD"])
        expect(head).toBe(info.baseSha)
      }),
    { git: true },
  )

  it.instance(
    "logs the provisioning boundary with run_id, worktree, branch, base_sha, step, exit_code, and duration_ms",
    () =>
      Effect.gen(function* () {
        const info = yield* pinnedInfo("structured-logs")
        const failed = { ...info, baseSha: "d".repeat(40) } as PinnedInfo
        yield* Effect.exit(Worktree.Service.use((svc) => svc.createFromInfo(failed)))
        yield* discardWorktree(info.directory)

        const lines = [...(yield* TestConsole.logLines), ...(yield* TestConsole.errorLines)]
        const logs = JSON.stringify(lines)
        for (const field of ["run_id", "worktree", "branch", "base_sha", "step", "exit_code", "duration_ms"]) {
          expect(logs).toContain(field)
        }
        yield* removeIfCreated(info.directory)
      }),
    { git: true },
  )

  it.instance(
    "keeps baseSha when the worktree adapter configures control-plane workspace info",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const store = yield* InstanceStore.Service
        const instance = yield* store.load({ directory: test.directory })
        const input = {
          id: "workspace-adapter-pin" as WorkspaceInfo["id"],
          type: "worktree",
          name: "workspace-adapter-pin",
          branch: null,
          directory: null,
          extra: null,
          projectID: instance.project.id,
        } satisfies WorkspaceInfo
        const configured = yield* Effect.tryPromise(() => Promise.resolve(WorktreeAdapter.configure(input, { instance })))

        expect((configured as WorkspaceInfo & { baseSha?: unknown }).baseSha).toMatch(/^[0-9a-f]{40}$/)
        const baseSha = (configured as WorkspaceInfo & { baseSha: string }).baseSha
        if (!configured.directory) throw new Error("configured worktree is missing its directory")
        yield* advancePrimary()
        yield* Effect.tryPromise(() => Promise.resolve(WorktreeAdapter.create(configured, {}, undefined, { instance })))
        expect(yield* git(configured.directory, ["rev-parse", "HEAD"])).toBe(baseSha)
      }),
    { git: true },
  )

  it.live("never changes the process working directory from src/worktree", () =>
    Effect.promise(async () => {
      const files = new Array<string>()
      for await (const file of new Bun.Glob("src/worktree/**/*.ts").scan({ cwd: path.resolve(import.meta.dir, "../..") })) {
        files.push(file)
      }
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        expect(await Bun.file(path.resolve(import.meta.dir, "../..", file)).text()).not.toMatch(/\bprocess\.chdir\s*\(/)
      }
    }),
  )
})
