import { LayerNode } from "@ranex/core/effect/layer-node"
import { graphql } from "@octokit/graphql"
import { Octokit } from "@octokit/rest"
import { Context, Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { resolveToken } from "./auth"
import type { ApiError, AuthMissing, GitHubError, RepoNotResolved } from "./error"
import * as Issues from "./issues"
import * as Milestones from "./milestones"
import * as Projects from "./projects"
import { makeResolveOwnerRepo } from "./repository"

export interface Interface {
  readonly resolveOwnerRepo: (input: {
    owner?: string
    repo?: string
  }) => Effect.Effect<{ owner: string; repo: string }, GitHubError | AuthMissing | RepoNotResolved | ApiError>
  readonly issue: (
    repo: { owner: string; repo: string },
    op: Issues.Operation,
  ) => Effect.Effect<Issues.Result, ApiError | AuthMissing>
  readonly milestone: (
    repo: { owner: string; repo: string },
    op: Milestones.Operation,
  ) => Effect.Effect<Milestones.Result, ApiError | AuthMissing>
  readonly project: (op: Projects.Operation) => Effect.Effect<Projects.Result, ApiError | AuthMissing>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/GitHub") {}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const git = yield* Git.Service

      const clients = yield* InstanceState.make(
        Effect.fn("GitHub.clients")(function* () {
          const token = yield* resolveToken()
          const octokit = new Octokit({ auth: token })
          const graphqlWithAuth = graphql.defaults({
            headers: { authorization: `token ${token}` },
          })
          return { octokit, graphqlWithAuth }
        }),
      )

      const resolveOwnerRepo = makeResolveOwnerRepo(git)

      return Service.of({
        resolveOwnerRepo,
        issue: (repo, op) =>
          Effect.gen(function* () {
            const { octokit } = yield* InstanceState.get(clients)
            return yield* Issues.handle(octokit, repo, op)
          }),
        milestone: (repo, op) =>
          Effect.gen(function* () {
            const { octokit } = yield* InstanceState.get(clients)
            return yield* Milestones.handle(octokit, repo, op)
          }),
        project: (op) =>
          Effect.gen(function* () {
            const { octokit, graphqlWithAuth } = yield* InstanceState.get(clients)
            return yield* Projects.handle({ octokit, graphql: graphqlWithAuth }, op)
          }),
      })
    }),
  ),
  deps: [Config.node, Git.node],
})

export * as GitHub from "./github"
