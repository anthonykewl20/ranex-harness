import { LayerNode } from "@ranex/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { resolveHost, resolveToken } from "./auth"
import { makeGraphqlClient, makeRestClient } from "./clients"
import type { ApiError, AuthMissing, GitHubError, RepoNotResolved } from "./error"
import * as Issues from "./issues"
import * as Milestones from "./milestones"
import * as Projects from "./projects"
import { makeResolveOwnerRepo } from "./repository"

export interface Interface {
  readonly resolveOwnerRepo: (input: {
    owner?: string
    repo?: string
  }) => Effect.Effect<{ host: string; owner: string; repo: string }, GitHubError | AuthMissing | RepoNotResolved | ApiError>
  readonly issue: (
    repo: { host: string; owner: string; repo: string },
    op: Issues.Operation,
  ) => Effect.Effect<Issues.Result, ApiError | AuthMissing>
  readonly milestone: (
    repo: { host: string; owner: string; repo: string },
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
          return new Map<
            string,
            {
              octokit: ReturnType<typeof makeRestClient>
              graphqlWithAuth: ReturnType<typeof makeGraphqlClient>
            }
          >()
        }),
      )

      const resolveOwnerRepo = makeResolveOwnerRepo(git)
      const getClients = Effect.fn("GitHub.clients.get")(function* (host: string) {
        const cache = yield* InstanceState.get(clients)
        const cached = cache.get(host)
        if (cached) return cached
        const token = yield* resolveToken({ host })
        const created = {
          octokit: makeRestClient(token, { host }),
          graphqlWithAuth: makeGraphqlClient(token, { host }),
        }
        cache.set(host, created)
        return created
      })

      return Service.of({
        resolveOwnerRepo,
        issue: (repo, op) =>
          Effect.gen(function* () {
            const activeClients = yield* getClients(repo.host)
            return yield* Issues.handle(activeClients.octokit, { owner: repo.owner, repo: repo.repo }, op)
          }),
        milestone: (repo, op) =>
          Effect.gen(function* () {
            const activeClients = yield* getClients(repo.host)
            return yield* Milestones.handle(activeClients.octokit, { owner: repo.owner, repo: repo.repo }, op)
          }),
        project: (op) =>
          Effect.gen(function* () {
            const activeClients = yield* getClients(resolveHost())
            return yield* Projects.handle(
              { octokit: activeClients.octokit, graphql: activeClients.graphqlWithAuth },
              op,
            )
          }),
      })
    }),
  ),
  deps: [Config.node, Git.node],
})

export { makeRestClient } from "./clients"

export * as GitHub from "./github"
