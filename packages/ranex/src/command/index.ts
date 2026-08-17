import { LayerNode } from "@ranex/core/effect/layer-node"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Duration, Effect, Fiber, Layer, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { LegacyEvent } from "@ranex/schema/legacy-event"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

type McpPrompt = Effect.Success<ReturnType<MCP.Interface["prompts"]>>[string]

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    // MCP prompt templates are prewarmed at registration through a manually
    // invalidatable cache: the first /command use pays no round trip when the
    // prewarm succeeded, misses join the in-flight fetch, and a server
    // reconnect re-fetches exactly once. Each reconnect swaps in a FRESH
    // cache instance under a new generation: invalidate() alone does not
    // unseat an in-flight run (its completion would repopulate the shared
    // cache with the stale template and latch it forever), while a fresh
    // instance starts idle and therefore always fetches against the new
    // client. Completions from a superseded generation never latch.
    const mcpPromptCommand = Effect.fn("Command.mcpPromptCommand")(function* (
      name: string,
      prompt: McpPrompt,
      bridge: EffectBridge.Shape,
    ) {
      const fetchTemplate = mcp
        .getPrompt(
          prompt.client,
          prompt.name,
          prompt.arguments
            ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
            : {},
        )
        .pipe(
          Effect.flatMap((template) => {
            if (template === undefined)
              return Effect.fail(
                new Error(`Failed to fetch prompt "${prompt.name}" from MCP server "${prompt.client}"`),
              )
            return Effect.succeed(
              template.messages
                .map((message) => (message.content.type === "text" ? message.content.text : ""))
                .join("\n") || "",
            )
          }),
        )
      let generation = 0
      let template: string | undefined
      let [cached, invalidate] = yield* Effect.cachedInvalidateWithTTL(fetchTemplate, Duration.infinity)
      const scope = yield* Effect.scope
      let prewarmFiber: Fiber.Fiber<void, never> | undefined
      // Interrupts the previous generation's prewarm so a superseded fetch
      // cannot linger, then forks this generation's into the registration
      // scope, so disposal still owns every fiber.
      const prewarm = (gen: number) =>
        Effect.gen(function* () {
          if (prewarmFiber) yield* Fiber.interrupt(prewarmFiber)
          prewarmFiber = yield* cached.pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                if (gen === generation) template = value
              }),
            ),
            Effect.ignore,
            Effect.forkIn(scope),
          )
        })
      yield* prewarm(0)
      const off = yield* mcp.onReconnect(prompt.client, () =>
        Effect.gen(function* () {
          generation++
          template = undefined
          ;[cached, invalidate] = yield* Effect.cachedInvalidateWithTTL(fetchTemplate, Duration.infinity)
          yield* prewarm(generation)
        }),
      )
      yield* Effect.addFinalizer(() => Effect.sync(off))
      return {
        name,
        source: "mcp" as const,
        description: prompt.description,
        get template(): Promise<string> | string {
          if (template !== undefined) return template
          const pending = bridge.promise(cached).catch((error: unknown) => {
            // Drop the latched failure so the next invocation retries.
            void bridge.promise(invalidate).catch(() => {})
            throw error
          })
          // Rejections must stay observable to the caller, but an unattached
          // rejected promise floating across await points would be reported
          // as unhandled before the caller gets to await it.
          pending.catch(() => {})
          return pending
        },
        hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
      } satisfies Info
    })

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = yield* mcpPromptCommand(name, prompt, bridge)
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        const dir = item.location === "<built-in>" ? undefined : path.dirname(item.location)
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            if (!dir) return item.content
            return [
              item.content,
              "",
              `Base directory for this skill: ${dir}`,
              "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
            ].join("\n")
          },
          hints: [],
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    // Command state freezes skill.all() at init; drop it when skills are
    // re-scanned so the next list()/get() rebuilds from fresh skills.
    const off = yield* skill.onInvalidate(() => InstanceState.invalidate(state))
    yield* Effect.addFinalizer(() => Effect.sync(off))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    return Service.of({ get, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node, MCP.node, Skill.node] })

export * as Command from "."
