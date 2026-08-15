import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Git } from "@ranex/core/git"
import { AppProcess } from "@ranex/core/process"
import { AbsolutePath, RelativePath } from "@ranex/core/schema"
import { branch, commit, gitRemote } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Git.node))

describe("Git", () => {
  it.live("clones a remote and reads checkout metadata", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = AbsolutePath.make(path.join(fixture.root, "checkout"))
        const repository = yield* git.repo.clone({ remote: fixture.remote, directory: target })

        expect(yield* git.remote.get(repository)).toBe(fixture.remote)
        expect(yield* git.history.head(repository)).toBeString()
        expect(yield* git.history.branch(repository)).toBe("main")
        expect(yield* git.history.defaultRemoteBranch(repository)).toBe("main")
        expect(repository.worktree).toBe(target)
        expect(repository.gitDirectory).toBe(AbsolutePath.make(path.join(target, ".git")))
        expect(repository.commonDirectory).toBe(repository.gitDirectory)
        expect(yield* read(path.join(target, "README.md"))).toBe("one\n")
      }),
    ),
  )

  it.live("fetches, checks out, and resets remote changes", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = AbsolutePath.make(path.join(fixture.root, "checkout"))
        const repository = yield* git.repo.clone({ remote: fixture.remote, directory: target })

        yield* Effect.promise(() => commit(fixture.source, "two\n", "second"))
        yield* git.sync.fetchRemotes(repository)
        yield* git.sync.resetHard(repository, "origin/main")
        expect(yield* read(path.join(target, "README.md"))).toBe("two\n")

        yield* Effect.promise(() => branch(fixture.source, "feature/docs", "feature\n"))
        yield* git.sync.fetchBranch(repository, { branch: "feature/docs" })
        yield* git.sync.checkoutRemoteBranch(repository, { branch: "feature/docs" })
        yield* git.sync.resetHard(repository, "origin/feature/docs")
        expect(yield* git.history.branch(repository)).toBe("feature/docs")
        expect(yield* read(path.join(target, "README.md"))).toBe("feature\n")
      }),
    ),
  )
})

function withRemote<A, E, R>(body: (fixture: Awaited<ReturnType<typeof gitRemote>>) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await tmpdir()
      return { root, fixture: await gitRemote(root.path) }
    }),
    (input) => body(input.fixture),
    (input) => Effect.promise(() => input.root[Symbol.asyncDispose]()),
  )
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replace(/\r\n/g, "\n")))
}

function processSpy(seen: string[][]) {
  return Layer.effect(
    AppProcess.Service,
    Effect.gen(function* () {
      const inner = yield* AppProcess.Service
      return AppProcess.Service.of({
        ...inner,
        run: (command, options) =>
          Effect.suspend(() => {
            if (ChildProcess.isStandardCommand(command)) seen.push([...command.args])
            return inner.run(command, options)
          }),
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(AppProcess.node)))
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}

describe("Git worktrees", () => {
  it.live("creates, lists, and removes linked worktrees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const directory = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const worktree = AbsolutePath.make(`${root.path}-git-worktree`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(worktree, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const git = yield* Git.Service
      const repo = yield* git.repo.discover(directory)
      if (!repo) throw new Error("Repository not found")

      yield* git.worktree.create({ repository: repo, directory: worktree })

      expect((yield* git.worktree.list(repo)).some((entry) => entry.directory.endsWith("-git-worktree"))).toBe(true)
      const linked = yield* git.repo.discover(worktree)
      expect(linked?.worktree).toBe(AbsolutePath.make(yield* Effect.promise(() => fs.realpath(worktree))))
      expect(linked?.commonDirectory).toBe(repo.commonDirectory)
      expect(linked?.gitDirectory).not.toBe(repo.gitDirectory)
      if (!linked) throw new Error("Linked worktree not found")
      yield* git.worktree.remove({ repository: linked, directory: worktree, force: false })
      expect((yield* git.worktree.list(repo)).some((entry) => entry.directory.endsWith("-git-worktree"))).toBe(false)
    }),
  )
})

describe("Git hardening", () => {
  const seen: string[][] = []
  const it = testEffect(AppNodeBuilder.build(Git.node, [[AppProcess.node, processSpy(seen)]]))

  it.live("prepends config hardening to discovered-repo invocations only", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => initRepo(tmp.path))
          const git = yield* Git.Service
          const repo = yield* git.repo.discover(AbsolutePath.make(tmp.path))
          if (!repo) throw new Error("Repository not found")

          seen.length = 0
          yield* git.history.head(repo)
          expect(seen[0]).toEqual([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "gc.auto=0",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "rev-parse",
            "HEAD",
          ])

          // The snapshot-style repository (isolated gitdir) keeps its argv untouched.
          seen.length = 0
          const storage = AbsolutePath.make(path.join(tmp.path, ".snapshot"))
          yield* git.repo.create({ worktree: repo.worktree, gitDirectory: storage, seed: repo })
          expect(seen.length).toBeGreaterThan(0)
          for (const args of seen) {
            expect(args.slice(0, 4)).not.toEqual(["-c", "core.fsmonitor=false", "-c", "gc.auto=0"])
            expect(args).not.toContain("core.hooksPath=/dev/null")
            expect(args).not.toContain("credential.helper=")
          }
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects option-shaped tree IDs and refnames before spawning", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => initRepo(tmp.path))
          const git = yield* Git.Service
          const repo = yield* git.repo.discover(AbsolutePath.make(tmp.path))
          if (!repo) throw new Error("Repository not found")
          const storage = AbsolutePath.make(path.join(tmp.path, ".snapshot"))
          const repository = yield* git.repo.create({ worktree: repo.worktree, gitDirectory: storage, seed: repo })

          seen.length = 0
          // `TreeID.make` validates in effect v4, so cast to simulate a value
          // that reached the boundary without construction-time validation.
          const tree = yield* git.tree.checkout({ repository, tree: "--index-output=x" as Git.TreeID }).pipe(
            Effect.flip,
          )
          expect(tree).toBeInstanceOf(Git.OperationError)
          expect(tree).toMatchObject({ operation: "restore" })

          const traversal = yield* git.sync.fetchBranch(repo, { branch: "--upload-pack=x" }).pipe(Effect.flip)
          expect(traversal).toBeInstanceOf(Git.OperationError)
          expect(traversal).toMatchObject({ operation: "fetch" })

          const dotted = yield* git.sync.fetchBranch(repo, { branch: "main..next" }).pipe(Effect.flip)
          expect(dotted).toBeInstanceOf(Git.OperationError)
          expect(dotted).toMatchObject({ operation: "fetch" })

          const revision = yield* git.sync.resetHard(repo, "--force").pipe(Effect.flip)
          expect(revision).toBeInstanceOf(Git.OperationError)
          expect(revision).toMatchObject({ operation: "reset" })

          // Blocklist mirrors git check-ref-format: separators, traversal,
          // ref-syntax metacharacters, and .lock-suffixed components.
          for (const unsafe of [
            "./main",
            "/main",
            "main/",
            "main.",
            "main//feature",
            "main@{upstream}",
            "main feature",
            "main:feature",
            "main?feature",
            "main*",
            "main[feature",
            "main\\feature",
            "main\x07feature",
            "refs/heads/main.lock",
            "feature/.hidden",
          ]) {
            const rejected = yield* git.sync.resetHard(repo, unsafe).pipe(Effect.flip)
            expect(rejected).toBeInstanceOf(Git.OperationError)
            expect(rejected).toMatchObject({ operation: "reset" })
          }

          expect(seen).toHaveLength(0)

          // Valid refs the old allowlist rejected: `@` (not followed by `{`)
          // and Unicode pass the guard and reach git itself, failing only as
          // unknown revisions.
          for (const valid of ["release@2026", "feature/ünïcode"]) {
            const unknown = yield* git.sync.resetHard(repo, valid).pipe(Effect.flip)
            expect(unknown).toBeInstanceOf(Git.OperationError)
            expect(unknown.message).not.toContain("Rejected unsafe git refname")
          }
          expect(seen).toHaveLength(2)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

describe("Git trees", () => {
  it.live("captures, compares, previews, and restores scoped trees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(async () => {
        await initRepo(root.path)
        await fs.mkdir(path.join(root.path, "scope"))
        await fs.writeFile(path.join(root.path, "scope", "tracked.txt"), "one\n")
        await fs.writeFile(path.join(root.path, "outside.txt"), "outside\n")
        await $`git add .`.cwd(root.path).quiet()
        await $`git commit -m initial`.cwd(root.path).quiet()
      })
      const git = yield* Git.Service
      const source = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!source) throw new Error("Repository not found")
      const storage = AbsolutePath.make(path.join(root.path, ".snapshot"))
      const repository = yield* git.repo.create({ worktree: source.worktree, gitDirectory: storage, seed: source })
      yield* git.index.refresh({ repository, scope: RelativePath.make("scope") })
      const before = yield* git.tree.write(repository)

      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(root.path, "scope", "tracked.txt"), "two\n")
        await fs.writeFile(path.join(root.path, "scope", "added.txt"), "added\n")
        await fs.writeFile(path.join(root.path, "outside.txt"), "changed outside\n")
      })
      yield* git.index.refresh({ repository, scope: RelativePath.make("scope") })
      const after = yield* git.tree.write(repository)

      expect(yield* git.tree.files({ repository, from: before, to: after })).toEqual([
        RelativePath.make("scope/added.txt"),
        RelativePath.make("scope/tracked.txt"),
      ])
      const diffs = yield* git.tree.diff({ repository, from: before, to: after, context: 1 })
      expect(diffs.map((item) => [item.path, item.status])).toEqual([
        [RelativePath.make("scope/added.txt"), "added"],
        [RelativePath.make("scope/tracked.txt"), "modified"],
      ])

      const files = new Map([[RelativePath.make("scope/tracked.txt"), before]])
      const preview = yield* git.tree.preview({ repository, current: after, files, context: 1 })
      expect(preview).toHaveLength(1)
      expect(preview[0]?.path).toBe(RelativePath.make("scope/tracked.txt"))
      yield* git.tree.restore({ repository, files })
      expect(yield* read(path.join(root.path, "scope", "tracked.txt"))).toBe("one\n")
      expect(yield* read(path.join(root.path, "scope", "added.txt"))).toBe("added\n")
      expect(yield* read(path.join(root.path, "outside.txt"))).toBe("changed outside\n")
    }),
  )
})
