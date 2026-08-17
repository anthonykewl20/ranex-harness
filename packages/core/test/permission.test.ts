import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@ranex/core/agent"
import { Database } from "@ranex/core/database/database"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { EventV2 } from "@ranex/core/event"
import { Location } from "@ranex/core/location"
import { PermissionV2 } from "@ranex/core/permission"
import { PermissionTable } from "@ranex/core/permission/sql"
import { PermissionSaved } from "@ranex/core/permission/saved"
import { Project } from "@ranex/core/project"
import { ProjectTable } from "@ranex/core/project/sql"
import { AbsolutePath } from "@ranex/core/schema"
import { SessionV2 } from "@ranex/core/session"
import { SessionTable } from "@ranex/core/session/sql"
import { SessionStore } from "@ranex/core/session/store"
import { eq, sql } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current]],
  ),
)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
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
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function waitForRequest(input: Partial<PermissionV2.AssertInput> = {}) {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion(input)).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

// Stands in for a process restart: rebuilds the permission graph against the
// same database so the layer constructor restores pending asks from the
// persisted permission_request rows. Layer.fresh detaches the rebuild from
// the enclosing layer builds, whose memoization would otherwise share the
// original service instances instead of restoring from the rows. The agents
// service is shared: its config-derived rules are stable across a restart,
// and only the permission restore is under test.
function restart<A, E>(effect: Effect.Effect<A, E, PermissionV2.Service | Database.Service>) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const agents = yield* AgentV2.Service
    yield* effect.pipe(
      Effect.provide(
        Layer.fresh(
          AppNodeBuilder.build(
            LayerNode.group([
              Database.node,
              EventV2.node,
              SessionStore.node,
              PermissionSaved.node,
              AgentV2.node,
              PermissionV2.node,
            ]),
            [
              [Location.node, current],
              [Database.node, Layer.succeed(Database.Service, { db })],
              [AgentV2.node, Layer.succeed(AgentV2.Service, agents)],
            ],
          ),
        ),
      ),
    )
  })
}

describe("PermissionV2", () => {
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(PermissionV2.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("cannot be bypassed by changing resource casing", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "Secrets/*", effect: "deny" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ resources: ["secrets/key.pem"] }))).toMatchObject({ effect: "deny" })
      expect(yield* service.ask(assertion({ resources: ["SECRETS/key.pem"] }))).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("keeps POSIX allow rules casing-strict while deny rules match broadly", () =>
    Effect.gen(function* () {
      // On POSIX, `allow Secrets/*` must not widen to `secrets/x` (the
      // directory is a different path on a case-sensitive filesystem), while
      // an exact-case resource still matches.
      yield* setup([{ action: "read", resource: "Secrets/*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ resources: ["Secrets/key.pem"] }))).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ resources: ["secrets/key.pem"] }))).toMatchObject({ effect: "ask" })

      // Deny rules keep matching across casing so they cannot be bypassed.
      yield* setRules([{ action: "read", resource: "Secrets/*", effect: "deny" }])
      expect(yield* service.ask(assertion({ resources: ["secrets/key.pem"] }))).toMatchObject({ effect: "deny" })
      expect(yield* service.ask(assertion({ resources: ["Secrets/key.pem"] }))).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("narrows allows to file-path scope", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const scope = { paths: ["src/**"] }
      expect(yield* service.ask(assertion({ resources: ["src/index.ts"], scope }))).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ resources: ["src/deep/nested.ts"], scope }))).toMatchObject({
        effect: "allow",
      })
      // Out-of-scope and mis-cased targets degrade the session-wide allow to ask.
      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_outside"), resources: ["lib/index.ts"], scope })),
      ).toMatchObject({ effect: "ask" })
      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_cased"), resources: ["SRC/index.ts"], scope })),
      ).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("narrows allows to MCP-server scope by exact server membership", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "mcp", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const scope = { servers: ["github"] }
      expect(yield* service.ask(assertion({ action: "mcp", resources: ["github"], scope }))).toMatchObject({
        effect: "allow",
      })
      expect(yield* service.ask(assertion({ action: "mcp", resources: ["github/create_issue"], scope }))).toMatchObject({
        effect: "allow",
      })
      expect(yield* service.ask(assertion({ action: "mcp", resources: ["github:list_repos"], scope }))).toMatchObject({
        effect: "allow",
      })
      expect(
        yield* service.ask(
          assertion({ action: "mcp", id: PermissionV2.ID.create("per_server"), resources: ["gitlab/create_issue"], scope }),
        ),
      ).toMatchObject({ effect: "ask" })
      // Membership is separator-bounded: a sibling server name must not sneak in.
      expect(
        yield* service.ask(
          assertion({
            action: "mcp",
            id: PermissionV2.ID.create("per_boundary"),
            resources: ["githubevil/create_issue"],
            scope,
          }),
        ),
      ).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("does not admit a file action through a servers scope on a colliding resource", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const scope = { servers: ["github"] }
      // `servers` cannot reason about path resources, so even a resource that
      // happens to look like a listed server degrades the allow to ask.
      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_cross_dir"), resources: ["github/creds.ts"], scope })),
      ).toMatchObject({ effect: "ask" })
      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_cross_exact"), resources: ["github"], scope })),
      ).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("does not admit an mcp action through a paths scope", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "mcp", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      // `paths` cannot reason about MCP server resources, even when the glob
      // textually covers them.
      expect(
        yield* service.ask(
          assertion({ action: "mcp", id: PermissionV2.ID.create("per_cross_mcp"), resources: ["github/create_issue"], scope: { paths: ["github/**"] } }),
        ),
      ).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("degrades allow to ask for actions with no scope vocabulary", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      // bash resources are commands, not paths or servers, so any scope on
      // the action is fail-closed: the delegation cannot vouch for it.
      expect(
        yield* service.ask(assertion({ action: "bash", id: PermissionV2.ID.create("per_bash_paths"), resources: ["pwd"], scope: { paths: ["**"] } })),
      ).toMatchObject({ effect: "ask" })
      expect(
        yield* service.ask(
          assertion({ action: "bash", id: PermissionV2.ID.create("per_bash_servers"), resources: ["pwd"], scope: { servers: ["github"] } }),
        ),
      ).toMatchObject({ effect: "ask" })
      // Unscoped evaluation of the same target keeps its allow.
      expect(
        yield* service.ask(assertion({ action: "bash", id: PermissionV2.ID.create("per_bash_bare"), resources: ["pwd"] })),
      ).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("degrades every allow to ask when the scope is present but empty", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      // A present-but-empty scope is fail-closed: nothing counts as in scope.
      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_empty_bare"), scope: {} })),
      ).toMatchObject({ effect: "ask" })
      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_empty_paths"), scope: { paths: [] } })),
      ).toMatchObject({ effect: "ask" })
      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_empty_servers"), scope: { servers: [] } })),
      ).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("aggregates per-resource scope degradation across mixed resources", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      // One out-of-scope target beside in-scope targets degrades the whole
      // request to ask under an otherwise session-wide allow.
      expect(
        yield* service.ask(
          assertion({
            id: PermissionV2.ID.create("per_mixed"),
            resources: ["src/index.ts", "lib/outside.ts"],
            scope: { paths: ["src/**"] },
          }),
        ),
      ).toMatchObject({ effect: "ask" })
    }),
  )

  it.effect("keeps deny rules absolute under scope", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "deny" }])
      const service = yield* PermissionV2.Service
      const scope = { paths: ["src/**"] }
      // Deny stands for out-of-scope targets too — scope never mutes it.
      expect(yield* service.ask(assertion({ resources: ["lib/outside.ts"], scope }))).toMatchObject({ effect: "deny" })
      expect(yield* service.ask(assertion({ resources: ["src/inside.ts"], scope }))).toMatchObject({ effect: "deny" })

      yield* setRules([
        { action: "read", resource: "*", effect: "allow" },
        { action: "read", resource: "secrets/*", effect: "deny" },
      ])
      expect(
        yield* service.ask(assertion({ resources: ["secrets/key.pem"], scope: { paths: ["secrets/**"] } })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("stays behavior-identical when scope is omitted", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.ask(assertion({ scope: undefined }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })

      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })

      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("never widens: out-of-scope targets fall through to ask", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const { service, fiber, request } = yield* waitForRequest({
        id: PermissionV2.ID.create("per_scoped"),
        resources: ["lib/outside.ts"],
        scope: { paths: ["src/**"] },
      })
      // The session-wide allow does not settle the assert; a human must.
      expect(request.resources).toEqual(["lib/outside.ts"])
      expect(yield* service.list()).toEqual([request])
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
    }),
  )

  it.effect("narrows saved always-allow rules to scope and leaves scoped requests pending", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const scope = { paths: ["src/**"] }
      // A scoped ask parks on human approval even though nothing allows it yet.
      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_stays"), resources: ["lib/a.ts"], scope })),
      ).toMatchObject({ effect: "ask" })
      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_twin"), resources: ["lib/c.ts"] })),
      ).toMatchObject({ effect: "ask" })
      expect(
        yield* service.ask(
          assertion({ id: PermissionV2.ID.create("per_saver"), resources: ["lib/b.ts"], save: ["lib/*"] }),
        ),
      ).toMatchObject({ effect: "ask" })

      // Replying always to the saver records `allow read lib/*`; the cascade
      // settles the unscoped twin but must skip the scoped request.
      yield* service.reply({ requestID: PermissionV2.ID.create("per_saver"), reply: "always" })
      expect((yield* service.list()).map((request) => request.id)).toEqual([PermissionV2.ID.create("per_stays")])
      expect(yield* service.get(PermissionV2.ID.create("per_twin"))).toBeUndefined()

      // Saved project-level approvals stay narrowed for later asks too.
      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_after"), resources: ["lib/a.ts"], scope })),
      ).toMatchObject({ effect: "ask" })
      expect(yield* service.ask(assertion({ resources: ["lib/a.ts"] }))).toMatchObject({ effect: "allow" })
      yield* service.reply({ requestID: PermissionV2.ID.create("per_stays"), reply: "once" })
      yield* service.reply({ requestID: PermissionV2.ID.create("per_after"), reply: "once" })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )

  it.effect("restores a persisted scope across a rebuild and keeps reply-time narrowing", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      // The scoped ask parks with an out-of-scope resource, so a restored
      // scope must keep the remembered rule from auto-settling it after the
      // restart — a dropped scope would silently widen the delegation.
      expect(
        yield* service.ask(
          assertion({
            action: "edit",
            id: PermissionV2.ID.create("per_restore_scoped"),
            resources: ["lib/keep.ts"],
            scope: { paths: ["src/**"] },
          }),
        ),
      ).toMatchObject({ effect: "ask" })
      expect(
        yield* service.ask(
          assertion({
            action: "edit",
            id: PermissionV2.ID.create("per_restore_saver"),
            resources: ["lib/b.ts"],
            save: ["lib/*"],
          }),
        ),
      ).toMatchObject({ effect: "ask" })

      yield* restart(
        Effect.gen(function* () {
          const service = yield* PermissionV2.Service
          expect((yield* service.list()).length).toBe(2)
          yield* service.reply({ requestID: PermissionV2.ID.create("per_restore_saver"), reply: "always" })
          // The remembered `allow edit lib/*` is saved, but the restored scope
          // keeps the out-of-scope ask pending instead of settling it.
          const { db } = yield* Database.Service
          expect(
            yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
          ).toMatchObject([{ action: "edit", resource: "lib/*" }])
          expect((yield* service.list()).map((request) => request.id)).toEqual([
            PermissionV2.ID.create("per_restore_scoped"),
          ])
          yield* service.reply({ requestID: PermissionV2.ID.create("per_restore_scoped"), reply: "once" })
        }),
      )
    }),
  )

  it.effect("restores a legacy row without scope as unscoped", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      expect(
        yield* service.ask(
          assertion({ action: "edit", id: PermissionV2.ID.create("per_restore_legacy"), resources: ["lib/legacy.ts"] }),
        ),
      ).toMatchObject({ effect: "ask" })
      expect(
        yield* service.ask(
          assertion({
            action: "edit",
            id: PermissionV2.ID.create("per_restore_legacy_saver"),
            resources: ["lib/b.ts"],
            save: ["lib/*"],
          }),
        ),
      ).toMatchObject({ effect: "ask" })

      yield* restart(
        Effect.gen(function* () {
          const service = yield* PermissionV2.Service
          yield* service.reply({ requestID: PermissionV2.ID.create("per_restore_legacy_saver"), reply: "always" })
          // Legacy evaluation survives the rebuild: the remembered rule is
          // saved and auto-settles the unscoped restored ask.
          const { db } = yield* Database.Service
          expect(
            yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
          ).toMatchObject([{ action: "edit", resource: "lib/*" }])
          expect(yield* service.list()).toEqual([])
        }),
      )
    }),
  )

  it.effect("fails closed when the persisted scope cannot be decoded", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      // The ask is admitted with an in-scope resource, then the stored scope
      // is corrupted so restore cannot recover the original narrowing.
      expect(
        yield* service.ask(
          assertion({
            action: "edit",
            id: PermissionV2.ID.create("per_restore_corrupt"),
            resources: ["src/corrupt.ts"],
            scope: { paths: ["src/**"] },
          }),
        ),
      ).toMatchObject({ effect: "ask" })
      expect(
        yield* service.ask(
          assertion({
            action: "edit",
            id: PermissionV2.ID.create("per_restore_corrupt_saver"),
            resources: ["src/b.ts"],
            save: ["src/*"],
          }),
        ),
      ).toMatchObject({ effect: "ask" })
      const { db } = yield* Database.Service
      yield* db.run(
        sql`UPDATE permission_request SET scope = ${JSON.stringify({ paths: 42 })} WHERE id = ${PermissionV2.ID.create("per_restore_corrupt")}`,
      )

      yield* restart(
        Effect.gen(function* () {
          const service = yield* PermissionV2.Service
          yield* service.reply({ requestID: PermissionV2.ID.create("per_restore_corrupt_saver"), reply: "always" })
          // Corrupted scope restores as empty — present but matching nothing —
          // so even the originally in-scope resource stays pending instead of
          // being auto-settled by the remembered rule.
          expect((yield* service.list()).map((request) => request.id)).toEqual([
            PermissionV2.ID.create("per_restore_corrupt"),
          ])
          yield* service.reply({ requestID: PermissionV2.ID.create("per_restore_corrupt"), reply: "once" })
        }),
      )
    }),
  )
})
