export * as Config from "./config"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { type ParseError, parse } from "jsonc-parser"
import { Context, Deferred, Effect, Layer, Option, Schema } from "effect"
import { Permission } from "@ranex/schema/permission"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"
import { Policy } from "./policy"
import { AbsolutePath } from "./schema"
import { ConfigAgent } from "./config/agent"
import { ConfigAttachments } from "./config/attachments"
import { ConfigCompaction } from "./config/compaction"
import { ConfigCommand } from "./config/command"
import { ConfigExperimental } from "./config/experimental"
import { ConfigFormatter } from "./config/formatter"
import { ConfigLSP } from "./config/lsp"
import { ConfigMCP } from "./config/mcp"
import { ConfigPlugin } from "./config/plugin"
import { ConfigProvider } from "./config/provider"
import { ConfigProviderFailover } from "./config/provider-failover"
import { ConfigProviderWatchdog } from "./config/provider-watchdog"
import { ConfigProviderRetry } from "./config/provider-retry"
import { ConfigProjectResolution } from "./config/project-resolution"
import { ConfigReference } from "./config/reference"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigWatcher } from "./config/watcher"
import { ConfigV1 } from "./v1/config/config"
import { ConfigMigrateV1 } from "./v1/config/migrate"

// The config directory is `.ranex`. `.opencode` is still discovered so a tree
// carried over from before the rebrand keeps working — this fork was opencode,
// and silently ignoring an existing config is a worse failure than answering to
// two names. `.ranex` is listed first so it wins wherever both exist.
const CONFIG_DIRECTORY = ".ranex"
const LEGACY_CONFIG_DIRECTORY = ".opencode"
const isConfigDirectory = (name: string) =>
  name === CONFIG_DIRECTORY || name === LEGACY_CONFIG_DIRECTORY

export class Info extends Schema.Class<Info>("Config.Info")({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(Schema.optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  default_agent: Schema.String.pipe(Schema.optional).annotate({
    description: "Default primary agent to use when no session agent is selected",
  }),
  autoupdate: Schema.Union([Schema.Boolean, Schema.Literal("notify")])
    .pipe(Schema.optional)
    .annotate({
      description: "Automatically update or notify when a new version is available",
    }),
  share: Schema.Literals(["manual", "auto", "disabled"]).pipe(Schema.optional).annotate({
    description: "Control whether sessions may be shared manually, automatically, or not at all",
  }),
  enterprise: Schema.Struct({
    url: Schema.String.pipe(Schema.optional),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Enterprise sharing service configuration",
    }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description: "Username displayed in conversations and used for telemetry identity",
  }),
  permissions: Permission.Ruleset.pipe(Schema.optional).annotate({
    description: "Ordered tool permission rules applied to agent tool use",
  }),
  agents: Schema.Record(Schema.String, ConfigAgent.Info).pipe(Schema.optional).annotate({
    description: "Named built-in agent overrides and custom agent definitions",
  }),
  snapshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable snapshots used for undo and revert behavior",
  }),
  watcher: ConfigWatcher.Info.pipe(Schema.optional).annotate({
    description: "Filesystem watcher configuration",
  }),
  formatter: ConfigFormatter.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in formatters or configure formatter overrides",
  }),
  lsp: ConfigLSP.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in language servers or configure server overrides",
  }),
  attachments: ConfigAttachments.Info.pipe(Schema.optional).annotate({
    description: "Attachment processing configuration",
  }),
  tool_output: ConfigToolOutput.Info.pipe(Schema.optional).annotate({
    description: "Tool output truncation thresholds",
  }),
  mcp: ConfigMCP.Info.pipe(Schema.optional).annotate({
    description: "MCP server configuration",
  }),
  compaction: ConfigCompaction.Info.pipe(Schema.optional).annotate({
    description: "Conversation compaction behavior",
  }),
  provider_watchdog: ConfigProviderWatchdog.Info.pipe(Schema.optional).annotate({
    description: "Provider stream inactivity and whole-turn watchdog timeouts",
  }),
  provider_retry: ConfigProviderRetry.Info.pipe(Schema.optional).annotate({
    description: "Bounded provider retry policy",
  }),
  provider_failover: ConfigProviderFailover.Info.pipe(Schema.optional).annotate({
    description: "Fallback models for provider-turn failures after same-model retries",
  }),
  project_resolution: ConfigProjectResolution.Info.pipe(Schema.optional).annotate({
    description: "Project and VCS resolution readiness deadline",
  }),
  skills: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs to discover skills from",
  }),
  commands: Schema.Record(Schema.String, ConfigCommand.Info).pipe(Schema.optional).annotate({
    description: "Named slash command definitions",
  }),
  instructions: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs supplying ambient instructions",
  }),
  references: ConfigReference.Info.pipe(Schema.optional).annotate({
    description: "Named local directories or Git repositories available as external context",
  }),
  plugins: ConfigPlugin.Plugins.pipe(Schema.optional).annotate({
    description: "Ordered external plugin packages to load",
  }),
  experimental: ConfigExperimental.Experimental.pipe(Schema.optional),
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(Schema.optional),
}) {}

export class Document extends Schema.Class<Document>("Config.Document")({
  type: Schema.Literal("document"),
  path: Schema.String.pipe(Schema.optional),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}) {}

export type Entry = Document | Directory

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .findLast((entry) => entry.info[key] !== undefined)?.info[key]
}

export interface Interface {
  /** Returns location config documents and supplemental directories from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
  /** Returns global-only entries for services that participate in project resolution itself. */
  readonly bootstrapEntries?: () => Effect.Effect<Entry[]>
  /** Installs the correctly bounded project config after asynchronous project resolution. */
  readonly loadProject?: (directory: AbsolutePath) => Effect.Effect<void, FSUtil.Error>
  /** Settles configuration to its global-only fallback when resolution fails. */
  readonly loadFallback?: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Config") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service
    const names = ["ranex.json", "ranex.jsonc"]
    const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
    const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
    const decodeV1Info = Schema.decodeUnknownOption(ConfigV1.Info, decodeOptions)

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      const text = yield* fs.readFileStringSafe(filepath)
      if (!text) return

      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return

      const info = Option.getOrUndefined(
        ConfigMigrateV1.isV1(input)
          ? decodeV1Info(input).pipe(Option.map(ConfigMigrateV1.migrate), Option.flatMap(decodeInfo))
          : decodeInfo(input),
      )
      if (!info) return
      ConfigPlugin.assertDisabled(info.plugins, filepath)
      return new Document({ type: "document", path: filepath, info })
    })

    const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
      return [
        ...(yield* Effect.forEach(names, (file) => loadFile(path.join(directory, file))).pipe(
          Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
        )),
        new Directory({ type: "directory", path: directory }),
      ]
    })

    const globalDirectory = AbsolutePath.make(global.config)
    const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)
    const globalEntries = yield* loadDirectory(globalDirectory).pipe(Effect.orDie)
    const ready = yield* Deferred.make<Entry[]>()
    const state = { entries: globalEntries, projectDirectory: undefined as AbsolutePath | undefined }
    const loadPolicy = (entries: Entry[]) =>
      policy.load(
        entries
          .filter((config): config is Document => config.type === "document")
          .toReversed()
          .flatMap((config) => config.info.experimental?.policies ?? []),
      )
    if (locationIsGlobal) {
      yield* loadPolicy(globalEntries)
      yield* Deferred.succeed(ready, globalEntries)
    }

    const loadProject = Effect.fn("Config.loadProject")(function* (projectDirectory: AbsolutePath) {
      if (locationIsGlobal || state.projectDirectory === projectDirectory) return
      const discovered = yield* fs.up({
        targets: [CONFIG_DIRECTORY, LEGACY_CONFIG_DIRECTORY, ...names.toReversed()],
        start: location.directory,
        stop: projectDirectory,
      })
      const directories = discovered
        .filter((item) => isConfigDirectory(path.basename(item)))
        .toReversed()
        .map((directory) => AbsolutePath.make(directory))
      // A config closer to the opened directory should win over one higher up.
      // Search starts nearby, so reverse the results before applying them.
      const direct = yield* Effect.forEach(
        discovered.filter((item) => !isConfigDirectory(path.basename(item))).toReversed(),
        loadFile,
      ).pipe(Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)))
      const supplementary = yield* Effect.forEach(directories, loadDirectory)
      // Apply general settings first and more specific settings last:
      // global config, project files, then config-directory files.
      const entries = [...globalEntries, ...direct, ...supplementary.flat()]
      // Policy statements are permission-adjacent (Policy.evaluate honors
      // allow statements), so project-sourced documents — direct files and
      // config directories between the opened directory and the project
      // root — must not grant; only global config may load them.
      yield* loadPolicy(globalEntries)
      state.entries = entries
      state.projectDirectory = projectDirectory
      yield* Deferred.succeed(ready, entries)
    })

    const loadFallback = Effect.fn("Config.loadFallback")(function* () {
      if (state.projectDirectory) return
      yield* loadPolicy(globalEntries)
      state.entries = globalEntries
      yield* Deferred.succeed(ready, globalEntries)
    })

    return Service.of({
      entries: Effect.fn("Config.entries")(function* () {
        yield* Deferred.await(ready)
        return state.entries
      }),
      bootstrapEntries: () => Effect.succeed(globalEntries),
      loadProject,
      loadFallback,
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Policy.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node],
})
