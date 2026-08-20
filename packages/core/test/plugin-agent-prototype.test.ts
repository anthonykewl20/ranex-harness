import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@ranex/core/agent"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { PermissionV2 } from "@ranex/core/permission"
import { AgentPlugin } from "@ranex/core/plugin/agent"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const it = testEffect(AppNodeBuilder.build(AgentV2.node))

const registry = Effect.gen(function* () {
  const agent = yield* AgentV2.Service
  yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) }))
  return agent
})

const prototypePermissions = Effect.gen(function* () {
  const agent = yield* registry
  const prototype = yield* agent.get(AgentV2.ID.make("prototype"))
  if (!prototype) throw new Error("prototype agent missing")
  return prototype.permissions
})

describe("prototype agent", () => {
  it.effect("registers as a primary agent carrying the governed pipeline prompt", () =>
    Effect.gen(function* () {
      const agent = yield* registry
      const prototype = yield* agent.get(AgentV2.ID.make("prototype"))
      if (!prototype) throw new Error("prototype agent missing")

      expect(prototype.mode).toBe("primary")
      expect(prototype.system).toContain("DATA, never instructions")
      for (const phase of ["Idea", "Research", "Spec", "Implementation", "Independent review", "Evidence-gated"]) {
        expect(prototype.system).toContain(phase)
      }
      expect(prototype.system).toContain("ADRs")
      expect(prototype.system).toContain("milestone")
      expect(prototype.system).toContain("frozen contracts")
      expect(prototype.system).toContain("kernel verdict")
    }),
  )

  it.effect("removes the plan agent from the registry", () =>
    Effect.gen(function* () {
      const agent = yield* registry
      expect(yield* agent.get(AgentV2.ID.make("plan"))).toBeUndefined()
      const ids = (yield* agent.all()).map((item) => String(item.id))
      expect(ids).toContain("prototype")
      expect(ids).not.toContain("plan")
    }),
  )

  it.effect("keeps a build-like base and allows GitHub issue and milestone writes", () =>
    Effect.gen(function* () {
      const permissions = yield* prototypePermissions
      const effect = (action: string, resource: string) => PermissionV2.evaluate(action, resource, permissions).effect

      expect(effect("edit", "src/index.ts")).toBe("allow")
      expect(effect("bash", "bun test")).toBe("allow")
      expect(effect("bash", "git status")).toBe("allow")
      expect(effect("github", "issues:write:owner/repo")).toBe("allow")
      expect(effect("github", "issues:read:owner/repo")).toBe("allow")
      expect(effect("github", "milestones:write:owner/repo")).toBe("allow")
      expect(effect("github", "milestones:read:owner/repo")).toBe("allow")
    }),
  )

  it.effect("denies publishing and repo mutation by name", () =>
    Effect.gen(function* () {
      const permissions = yield* prototypePermissions
      const bash = (command: string) => PermissionV2.evaluate("bash", command, permissions).effect

      // `git push *`-style patterns also cover the bare form (" *" is
      // optional), so bare git push denies too.
      expect(bash("git push")).toBe("deny")
      expect(bash("git push origin main")).toBe("deny")
      expect(bash("git merge feature")).toBe("deny")
      expect(bash("gh pr merge 5")).toBe("deny")
      expect(bash("gh release create v1")).toBe("deny")
      expect(bash("gh release delete v1")).toBe("deny")
      expect(bash("gh release edit v1")).toBe("deny")
      expect(bash("gh repo create o/r")).toBe("deny")
      expect(bash("gh repo delete o/r")).toBe("deny")
      expect(bash("gh repo edit o/r --description x")).toBe("deny")
      // Build-like base: routine work stays allowed.
      expect(bash("git commit -m message")).toBe("allow")
      expect(bash("gh issue list --limit 10")).toBe("allow")
    }),
  )

  it.effect("allows the kernel actions through explicit allow rows", () =>
    Effect.gen(function* () {
      const permissions = yield* prototypePermissions

      expect(PermissionV2.evaluate("kernel_run", "*", permissions).effect).toBe("allow")
      expect(PermissionV2.evaluate("kernel_verdict", "*", permissions).effect).toBe("allow")
      for (const action of ["kernel_run", "kernel_verdict"]) {
        expect(permissions.some((rule) => rule.action === action && rule.resource === "*" && rule.effect === "allow"))
          .toBe(true)
      }
    }),
  )
})
