export * as TuiConfig from "./tui"

import path from "path"
import { mergeDeep, unique } from "remeda"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Cause, Context, Effect, Fiber, Layer } from "effect"
import { ConfigParse } from "@/config/parse"
import * as ConfigPaths from "@/config/paths"
import { migrateTuiConfig } from "./tui-migrate"
import { resolveHostAttentionSoundPaths } from "./tui-host-attention"
import { Flag } from "@ranex/core/flag/flag"
import { isRecord } from "@ranex/tui/util/record"
import { Global } from "@ranex/core/global"
import { FSUtil } from "@ranex/core/fs-util"
import { TuiKeybind } from "@ranex/tui/config/keybind"
import { makeRuntime } from "@ranex/core/effect/runtime"
import { Filesystem } from "@/util/filesystem"
import { ConfigVariable } from "@/config/variable"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { TuiConfig } from "@ranex/tui/config"

export const Info = TuiConfig.Info
export type Info = TuiConfig.Info

export type Resolved = TuiConfig.Resolved

export interface Interface {
  readonly get: () => Effect.Effect<Resolved>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TuiConfig") {}

function normalize(raw: Record<string, unknown>) {
  const data = { ...raw }
  if (!("tui" in data)) return data
  if (!isRecord(data.tui)) {
    delete data.tui
    return data
  }

  const tui = data.tui
  delete data.tui
  return {
    ...tui,
    ...data,
  }
}

function dropUnknownKeybinds(input: Record<string, unknown>) {
  if (!isRecord(input.keybinds)) return input

  const invalid = TuiKeybind.unknownKeys(input.keybinds)
  if (!invalid.length) return input

  return {
    ...input,
    keybinds: Object.fromEntries(Object.entries(input.keybinds).filter(([key]) => !invalid.includes(key))),
  }
}

const loadState = Effect.fn("TuiConfig.loadState")(function* (ctx: { directory: string }) {
  const afs = yield* FSUtil.Service
  let appliedOrder = 0

  const load = (text: string, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: configFilepath, missing: "empty" }),
      )
      const data = ConfigParse.jsonc(expanded, configFilepath)
      if (!isRecord(data)) return {} as Info
      // Flatten a nested "tui" key so users who wrote `{ "tui": { ... } }` inside tui.json
      // (mirroring the old ranex.json shape) still get their settings applied.
      const normalized = dropUnknownKeybinds(normalize(data))
      const parsed = ConfigParse.schema(Info, normalized, configFilepath)
      const validated = parsed.attention?.sounds
        ? {
            ...parsed,
            attention: {
              ...parsed.attention,
              sounds: resolveHostAttentionSoundPaths(path.dirname(configFilepath), parsed.attention.sounds),
            },
          }
        : parsed
      return validated
    }).pipe(
      // catchCause (not tapErrorCause + orElseSucceed) because JSONC parsing and validation
      // can sync-throw — those become defects, which orElseSucceed wouldn't catch.
      Effect.catchCause((cause) =>
        Effect.logWarning("skipping invalid tui config", {
          path: configFilepath,
          reason: FormatError(Cause.squash(cause)) ?? FormatUnknownError(Cause.squash(cause)),
        }).pipe(Effect.as({} as Info)),
      ),
    )

  const loadFile = (filepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      // Silent-swallow non-NotFound read errors (perms, EISDIR, IO) → log + skip.
      // Matches how parse/schema/plugin failures in load() are handled — every
      // broken-config path degrades gracefully rather than crashing TUI startup.
      const text = yield* afs.readFileStringSafe(filepath).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to read tui config", {
            path: filepath,
            reason: FormatError(Cause.squash(cause)) ?? FormatUnknownError(Cause.squash(cause)),
          }).pipe(Effect.as(undefined)),
        ),
      )
      if (!text) return {} as Info
      yield* Effect.logInfo("loading tui config", { path: filepath })
      return yield* load(text, filepath)
    })

  const mergeFile = (result: Info, file: string) =>
    Effect.gen(function* () {
      const data = yield* loadFile(file)
      if (Object.keys(data).length) {
        appliedOrder += 1
        yield* Effect.logInfo("applying tui config", { path: file, order: appliedOrder })
      }
      return mergeDeep(result, data)
    })

  // Every config dir we may read from: global config dir, any `.opencode`
  // folders between cwd and home, and RANEX_CONFIG_DIR.
  const directories = yield* ConfigPaths.directories(ctx.directory)
  yield* Effect.promise(() => migrateTuiConfig({ directories, cwd: ctx.directory }))

  const projectFiles = Flag.RANEX_DISABLE_PROJECT_CONFIG ? [] : yield* ConfigPaths.files("tui", ctx.directory)

  let result: Info = {}

  // 1. Global tui config (lowest precedence).
  for (const file of ConfigPaths.fileInDirectory(Global.Path.config, "tui")) {
    result = yield* mergeFile(result, file)
  }

  // 2. Explicit RANEX_TUI_CONFIG override, if set.
  if (Flag.RANEX_TUI_CONFIG) {
    const configFile = Flag.RANEX_TUI_CONFIG
    result = yield* mergeFile(result, configFile)
    yield* Effect.logDebug("loaded custom tui config", { path: configFile })
  }

  // 3. Project tui files, applied root-first so the closest file wins.
  for (const file of projectFiles) {
    result = yield* mergeFile(result, file)
  }

  // 4. `.opencode` directories (and RANEX_CONFIG_DIR) discovered while
  // walking up the tree. Also returned below so callers can install plugin
  // dependencies from each location.
  const dirs = unique(directories).filter((dir) => dir.endsWith(".opencode") || dir === Flag.RANEX_CONFIG_DIR)

  for (const dir of dirs) {
    if (!dir.endsWith(".opencode") && dir !== Flag.RANEX_CONFIG_DIR) continue
    for (const file of ConfigPaths.fileInDirectory(dir, "tui")) {
      result = yield* mergeFile(result, file)
    }
  }

  const resolved = TuiConfig.resolve(
    {
      ...result,
    },
    {
      terminalSuspend: process.platform !== "win32",
    },
  )

  return {
    config: resolved,
    dirs: [],
  }
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const data = yield* loadState({ directory: process.cwd() })

    const get = Effect.fn("TuiConfig.get")(() => Effect.succeed(data.config))
    const waitForDependencies = Effect.fn("TuiConfig.waitForDependencies")(() => Effect.void)
    return Service.of({ get, waitForDependencies })
  }).pipe(Effect.withSpan("TuiConfig.layer")),
)

export const node = LayerNode.make({ service: Service, layer, deps: [FSUtil.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export async function waitForDependencies() {
  await runPromise((svc) => svc.waitForDependencies())
}

export async function get() {
  return runPromise((svc) => svc.get())
}
