import { LayerNode } from "@ranex/core/effect/layer-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Agent.node))

// Mirrors a legacy session loaded from storage (session.ts maps messages via
// `agent: row.agent ?? undefined`): messages persist the agent NAME that was
// active when they were written — "plan" before the prototype agent replaced
// it. Rows from before the switch must keep loading after the registry no
// longer contains that name.
const legacyPlanSession = [
  { id: "msg_user_1", role: "user", agent: "plan", text: "Draft a plan for the parser rewrite" },
  { id: "msg_assistant_1", role: "assistant", agent: "plan", text: "I will start by exploring src/parser." },
] as const

// The lookup session/processor.ts performs on a persisted assistant message
// (`agents.get(ctx.assistantMessage.agent)`) — at baseline this returned
// undefined and crashed on `.permission` access.
const resolveAgent = (name: string) => Agent.use.get(name)

it.instance("persisted agent:'plan' messages resolve to the default agent without error", () =>
  Effect.gen(function* () {
    const fallback = yield* Agent.use.defaultInfo()
    for (const message of legacyPlanSession) {
      const resolved = yield* resolveAgent(message.agent)
      expect(resolved.name).toBe(fallback.name)
      expect(resolved.mode).toBe("primary")
      expect(resolved.permission.length).toBeGreaterThan(0)
    }
  }),
)

it.instance("historical transcript names render as data", () =>
  Effect.gen(function* () {
    const resolved = yield* resolveAgent("plan")
    // The historical name is inert data: it never re-resolves to a
    // plan-shaped agent (resolution targets the default agent), and the
    // transcript rows keep rendering the persisted name verbatim.
    expect(resolved.name).not.toBe("plan")

    const rendered = []
    for (const message of legacyPlanSession) {
      yield* resolveAgent(message.agent)
      rendered.push({ text: message.text, agent: message.agent })
    }
    expect(rendered.map((row) => row.agent)).toEqual(["plan", "plan"])
    expect(rendered[0].text).toContain("parser rewrite")
  }),
)

it.instance("any unknown or removed agent name resolves to the default agent", () =>
  Effect.gen(function* () {
    const fallback = yield* Agent.use.defaultInfo()
    // "plan": retired registry name; "PLAN": case-sensitivity miss; "": empty
    // lookup; "no_such_agent": never-registered name. All take the same
    // generic fallback — no plan-only special case.
    for (const name of ["plan", "PLAN", "", "no_such_agent"]) {
      const resolved = yield* resolveAgent(name)
      expect(resolved.name).toBe(fallback.name)
      expect(resolved.name).toBe("build")
    }
  }),
)

it.instance(
  "prototype removed from the registry by config resolves to the default agent",
  () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service.use((svc) => svc.list())
      expect(agents.map((a) => a.name)).not.toContain("prototype")

      const resolved = yield* resolveAgent("prototype")
      expect(resolved.name).toBe("build")
      expect(resolved.mode).toBe("primary")
    }),
  {
    config: {
      agent: {
        prototype: { disable: true },
      },
    },
  },
)
