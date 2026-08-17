import { LayerNode } from "@ranex/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Context, Schema, Cause, FiberHandle, ScopedCache } from "effect"
import { NamedError } from "@ranex/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@ranex/core/global"
import { SkillPlugin } from "@ranex/core/plugin/skill"
import { Watcher } from "@ranex/core/filesystem/watcher"
import { Permission } from "@/permission"
import { FSUtil } from "@ranex/core/fs-util"
import { Config } from "@/config/config"
import { FrontmatterError } from "@ranex/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@ranex/core/util/glob"
import { Discovery } from "./discovery"
import { isRecord } from "@/util/record"
import { escapeHtml } from "@/util/html"

const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const RANEX_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

// Built-in skill that ships with opencode. The model's intuition for what an
// ranex.json should look like is often wrong, and opencode hard-fails on
// invalid config, so users hit cryptic startup errors. Loading this skill
// when the model is asked to touch opencode's own config files gives it the
// actual schemas instead of guesses.
const CUSTOMIZE_RANEX_SKILL_NAME = "customize-opencode"
const CUSTOMIZE_RANEX_SKILL_DESCRIPTION =
  "Use ONLY when the user is editing or creating Ranex's own configuration: ranex.json, ranex.jsonc, files under .opencode/, or files under ~/.config/ranex/. Also use when creating or fixing Ranex agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring Ranex itself."
const CUSTOMIZE_RANEX_SKILL_BODY = SkillPlugin.CustomizeOpencodeContent

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
}

type DiscoveryState = {
  matches: string[]
  dirs: string[]
  // Directories that were scanned for skills; watching these covers new,
  // edited, and removed SKILL.md files without another discovery pass.
  roots: string[]
}

type ScanState = {
  matches: Set<string>
  dirs: Set<string>
  roots: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
  /** Drops cached discovery and skill state for the current instance so later reads re-scan disk. */
  readonly refresh: () => Effect.Effect<void>
  /**
   * Registers a hook fired whenever skill state is invalidated (explicit
   * refresh or watcher flush) so dependents that froze skill listings, like
   * Command, drop their stale copies. Returns an unsubscribe function.
   */
  readonly onInvalidate: (hook: () => Effect.Effect<void>) => Effect.Effect<() => void>
}

const add = Effect.fnUntraced(function* (state: State, match: string, events: EventV2Bridge.Service["Service"]) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        yield* Effect.logError("failed to load skill", { skill: match, error: err })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) return

  if (state.skills[md.data.name]) {
    yield* Effect.logWarning("duplicate skill name", {
      name: md.data.name,
      existing: state.skills[md.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[md.data.name] = {
    name: md.data.name,
    description: md.data.description,
    location: match,
    content: md.content,
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      return Effect.logError(`failed to scan ${opts.scope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  for (const match of matches) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
  state.roots.add(root)
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), dirs: new Set(), roots: new Set() }

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, RANEX_SKILL_PATTERN)
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: Array.from(state.matches),
    dirs: Array.from(state.dirs),
    roots: Array.from(state.roots),
  }
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  events: EventV2Bridge.Service["Service"],
) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, events), {
    concurrency: "unbounded",
    discard: true,
  })

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length })
})

// Filesystem events under a discovery root trigger a debounced flush that
// invalidates cached state so write bursts coalesce into one re-scan.
const WATCH_DEBOUNCE = "1 second"

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set() }
        // Register the built-in skill BEFORE disk discovery so a user-disk
        // skill with the same name can override it.
        s.skills[CUSTOMIZE_RANEX_SKILL_NAME] = {
          name: CUSTOMIZE_RANEX_SKILL_NAME,
          description: CUSTOMIZE_RANEX_SKILL_DESCRIPTION,
          location: "<built-in>",
          content: CUSTOMIZE_RANEX_SKILL_BODY,
        }
        yield* loadSkills(s, yield* InstanceState.get(discovered), events)
        // Lazily starts this directory's skill watchers; the entry scope keeps
        // them alive until the instance is disposed or a refresh replaces them.
        yield* InstanceState.get(watched)
        return s
      }),
    )

    // Dependents like Command freeze skill listings into their own instance
    // state; these hooks let them drop that state whenever skills are
    // re-scanned, for the directory the flush or refresh runs under.
    const invalidateHooks: Array<() => Effect.Effect<void>> = []
    const notifyInvalidated = Effect.forEach(invalidateHooks, (hook) => hook().pipe(Effect.ignore), {
      concurrency: "unbounded",
      discard: true,
    })

    const onInvalidate = Effect.fn("Skill.onInvalidate")(function* (hook: () => Effect.Effect<void>) {
      invalidateHooks.push(hook)
      return () => {
        const index = invalidateHooks.indexOf(hook)
        if (index >= 0) invalidateHooks.splice(index, 1)
      }
    })

    // Per-instance scoped watchers over the discovery roots. The ScopedCache
    // entry scope owns the subscriptions, so invalidating or disposing the
    // instance releases them; the flush only invalidates discovery and skill
    // state and never its own entry, which would interrupt the flush itself.
    // The annotation breaks the state<->watched type inference cycle.
    const watched: InstanceState.InstanceState<void> = yield* InstanceState.make(
      Effect.fnUntraced(function* (ctx) {
        const directory = ctx.directory
        const context = yield* Effect.context()
        const runFork = Effect.runForkWith(context)
        const pending = yield* FiberHandle.make()

        const resync = Effect.gen(function* () {
          const roots = (yield* ScopedCache.get(discovered.cache, directory)).roots
          yield* watchSet.reconcile(roots)
        })

        const flush = Effect.gen(function* () {
          yield* Effect.sleep(WATCH_DEBOUNCE)
          yield* ScopedCache.invalidate(discovered.cache, directory)
          yield* ScopedCache.invalidate(state.cache, directory)
          // Skill state rebuilds lazily on the next read; discovery re-runs now
          // so new and removed roots are watched immediately.
          yield* resync
          yield* notifyInvalidated
        }).pipe(
          Effect.catchCause((cause) => Effect.logError("skill watch refresh failed", { cause: Cause.pretty(cause) })),
        )

        // Explicitly typed: resync's subscription callbacks reference this
        // before its initializer runs, and the annotation breaks the cycle.
        const trigger: () => void = () => runFork(FiberHandle.run(pending, flush))

        const watchSet = yield* Watcher.makeWatchSet(trigger)
        // Registered before the initial resync so disposal during that
        // reconcile still releases whatever subscribed so far.
        yield* Effect.addFinalizer(() => watchSet.release)
        yield* resync
      }),
    )

    const refresh = Effect.fn("Skill.refresh")(function* () {
      const directory = yield* InstanceState.directory
      yield* ScopedCache.invalidate(discovered.cache, directory)
      yield* ScopedCache.invalidate(state.cache, directory)
      yield* ScopedCache.invalidate(watched.cache, directory)
      yield* notifyInvalidated
      yield* InstanceState.get(state)
    })

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      if (info) return info
      return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    return Service.of({ get, require, all, dirs, available, refresh, onInvalidate })
  }),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${escapeHtml(skill.location)}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Discovery.node, Config.node, EventV2Bridge.node, FSUtil.node, Global.node, RuntimeFlags.node],
})

export * as Skill from "."
