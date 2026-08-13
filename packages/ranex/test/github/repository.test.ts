import { $ } from "bun"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { Git } from "../../src/git"
import { RepoNotResolved } from "../../src/github/error"
import { makeResolveOwnerRepo } from "../../src/github/repository"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

const resolveOwnerRepo = (input: { owner?: string; repo?: string }) =>
  Effect.gen(function* () {
    const git = yield* Git.Service
    return yield* makeResolveOwnerRepo(git)(input)
  })

describe("github.repository.resolveOwnerRepo", () => {
  it.instance("uses an explicit owner and repo as-is", () =>
    Effect.gen(function* () {
      expect(yield* resolveOwnerRepo({ owner: "TestOwner", repo: "TestRepo" })).toEqual({
        host: "github.com",
        owner: "TestOwner",
        repo: "TestRepo",
      })
    }),
  )

  it.instance("rejects partial overrides", () =>
    Effect.gen(function* () {
      for (const input of [{ owner: "testowner" }, { repo: "testrepo" }]) {
        const exit = yield* resolveOwnerRepo(input).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(RepoNotResolved)
      }
    }),
  )

  it.instance(
    "resolves owner and repo from a GitHub origin",
    () =>
      Effect.gen(function* () {
        expect(yield* resolveOwnerRepo({})).toEqual({ host: "github.com", owner: "testowner", repo: "testrepo" })
      }),
    {
      git: true,
      init: (directory) =>
        Effect.promise(() => $`git remote add origin https://github.com/testowner/testrepo.git`.cwd(directory).quiet()).pipe(
          Effect.asVoid,
        ),
    },
  )

  it.instance(
    "resolves an enterprise GitHub origin",
    () =>
      Effect.gen(function* () {
        expect(yield* resolveOwnerRepo({})).toEqual({
          host: "github.example.com",
          owner: "testowner",
          repo: "testrepo",
        })
      }),
    {
      git: true,
      init: (directory) =>
        Effect.promise(() =>
          $`git remote add origin https://github.example.com/testowner/testrepo.git`.cwd(directory).quiet(),
        ).pipe(Effect.asVoid),
    },
  )
})
