import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@ranex/core/agent"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { Location } from "@ranex/core/location"
import { PermissionV2 } from "@ranex/core/permission"
import { AgentPlugin } from "@ranex/core/plugin/agent"
import { AbsolutePath } from "@ranex/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const it = testEffect(AppNodeBuilder.build(AgentV2.node))

const planPermissions = Effect.gen(function* () {
  const agent = yield* AgentV2.Service
  yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) })).pipe(
    Effect.provideService(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
    ),
  )
  const plan = yield* agent.get(AgentV2.ID.make("plan"))
  if (!plan) throw new Error("plan agent missing")
  return plan.permissions
})

describe("plan agent bash policy", () => {
  it.effect("denies mutating git commands, allows read-only ones, and asks for the rest", () =>
    Effect.gen(function* () {
      const permissions = yield* planPermissions
      const bash = (command: string) => PermissionV2.evaluate("bash", command, permissions).effect

      expect(bash("git push origin main")).toBe("deny")
      expect(bash("git push")).toBe("deny")
      expect(bash("git commit -m message")).toBe("deny")
      expect(bash("git status")).toBe("allow")
      expect(bash("git log --oneline -5")).toBe("allow")
      expect(bash("gh issue list --limit 10")).toBe("allow")
      // git log/diff/show --output writes to an arbitrary path: denied even
      // though the plain read-only forms are allowed.
      expect(bash("git log --output=/tmp/evil")).toBe("deny")
      expect(bash("git diff --output=/tmp/evil")).toBe("deny")
      expect(bash("git show --output=/tmp/evil")).toBe("deny")
      // spaced form and any prefix position must deny too, not just the
      // compact `--output=` form at the front.
      expect(bash("git log --output /tmp/evil")).toBe("deny")
      expect(bash("git log -1 --output /tmp/evil")).toBe("deny")
      expect(bash("git log -1 --output=/tmp/evil")).toBe("deny")
      expect(bash("git diff HEAD~1 --output=/tmp/evil")).toBe("deny")
      expect(bash("git show HEAD --output=/tmp/evil")).toBe("deny")
      expect(bash("git log -1")).toBe("allow")
      // `find` is not on the allow list: -delete/-exec mutate without shell
      // control characters, so every find invocation falls through to ask.
      expect(bash("find . -type f -delete")).toBe("ask")
      expect(bash("find . -name package.json")).toBe("ask")
      expect(bash("rm -rf /")).toBe("ask")
      expect(bash("ls -la")).toBe("allow")
    }),
  )

  it.effect("still denies edits outside the plan directories", () =>
    Effect.gen(function* () {
      const permissions = yield* planPermissions
      expect(PermissionV2.evaluate("edit", "src/index.ts", permissions).effect).toBe("deny")
    }),
  )
})
