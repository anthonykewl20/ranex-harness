export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Skill } from "@ranex/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
  readonly refresh: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

// URL cache entries revalidate on read once older than this TTL (default
// 10 minutes); read from the environment per call so changes apply without
// a restart.
const DEFAULT_URL_TTL_MS = 600_000

function ttl() {
  const value = process.env.RANEX_SKILL_URL_TTL_MS
  if (value === undefined || !/^\d+$/.test(value)) return DEFAULT_URL_TTL_MS
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_URL_TTL_MS
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      const skills: Info[] = []
      if (source.type === "embedded") return [source.skill]
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      for (const directory of directories) {
        const files = yield* fs
          .glob("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) continue
          const markdown = ConfigMarkdown.parseOption(content)
          if (!markdown) continue
          const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
          if (!frontmatter) continue
          const name =
            frontmatter.name !== undefined
              ? frontmatter.name
              : path.dirname(filepath) === directory
                ? path.basename(filepath, ".md")
                : undefined
          if (!name) continue
          skills.push({
            name,
            description: frontmatter.description,
            slash: frontmatter.slash,
            location: AbsolutePath.make(filepath),
            content: markdown.content,
          })
        }
      }
      return skills
    })

    // Cached per source: refresh() invalidates directory entries so skill
    // edits become visible without a restart (watchers in ./watch call
    // refresh on filesystem events); url entries revalidate on read once
    // older than the TTL (default 10 minutes, tunable via
    // RANEX_SKILL_URL_TTL_MS) and embedded entries stay cached for the
    // process lifetime.
    const cache = new Map<string, Info[]>()
    const pulledAt = new Map<string, number>()
    const list = Effect.fn("SkillV2.list")(function* () {
      const skills = new Map<string, Info>()
      for (const source of state.get().sources) {
        const key = Source.key(source)
        const cached = cache.get(key)
        // url entries revalidate on read once older than the TTL; a
        // revalidation that comes back EMPTY while a non-empty entry is
        // cached retains the last result and retries next window (network
        // failures degrade to one-window-old content instead of vanishing
        // skills). Directory entries are invalidated by refresh() and
        // embedded entries never age.
        const stale = source.type === "url" && Date.now() - (pulledAt.get(key) ?? 0) >= ttl()
        const loaded = cached !== undefined && !stale ? cached : (yield* load(source))
        // discovery.pull returns [] on transient network failure, so an
        // empty stale revalidation keeps the previous skills serving; a
        // genuinely emptied registry propagates after at most one window.
        const effective =
          stale && cached !== undefined && cached.length > 0 && loaded.length === 0 ? cached : loaded
        cache.set(key, effective)
        if (source.type === "url" && (stale || cached === undefined)) pulledAt.set(key, Date.now())
        for (const skill of effective) skills.set(skill.name, skill)
      }
      return Array.from(skills.values())
    })

    // Invalidates only the cache entries a filesystem event can change —
    // directory sources, which are re-read from disk — plus entries whose
    // source no longer exists, then reloads so later list() calls observe
    // current state directly. HTTP sources are not re-pulled through
    // discovery: a local filesystem event cannot have changed them, so url
    // and embedded entries stay cached here; a stale url entry still
    // re-pulls at most once per TTL window, including on the list() this
    // refresh performs (bounded churn).
    const refresh = Effect.fn("SkillV2.refresh")(function* () {
      const keep = new Set(
        state.get().sources.flatMap((source) => (source.type === "directory" ? [] : [Source.key(source)])),
      )
      for (const key of cache.keys()) {
        if (!keep.has(key)) cache.delete(key)
      }
      for (const key of pulledAt.keys()) {
        if (!keep.has(key)) pulledAt.delete(key)
      }
      yield* list().pipe(Effect.asVoid)
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
      refresh,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillDiscovery.node, FSUtil.node] })
