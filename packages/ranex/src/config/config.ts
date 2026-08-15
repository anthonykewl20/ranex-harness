import { LayerNode } from "@ranex/core/effect/layer-node"
import { httpClient } from "@ranex/core/effect/app-node-platform"
import { serviceUse } from "@ranex/core/effect/service-use"
import path from "path"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@ranex/core/global"
import fsNode from "fs/promises"
import { Flag } from "@ranex/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { InstallationLocal, InstallationVersion } from "@ranex/core/installation/version"
import { existsSync } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@ranex/core/v1/config/console-state"
import { FSUtil } from "@ranex/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EffectFlock } from "@ranex/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@ranex/core/v1/config/config"
import { ConfigErrorV1, RemoteAuthError } from "@ranex/core/v1/config/error"
import { ConfigPermissionV1 } from "@ranex/core/v1/config/permission"
import { ConfigPluginV1 } from "@ranex/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigVariable } from "./variable"
import { Npm } from "@ranex/core/npm"
import { withTransientReadRetry } from "@/util/effect-http-client"

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

// Option keys the provider lowerers (core/v1/config/provider-options.ts),
// migrate.ts, and the provider factories (provider/provider.ts) turn into
// credentials, auth headers, request URLs, or request-host components. A
// hostile repo can use them to redirect provider traffic and exfiltrate
// stored keys.
const providerCredentialOptionKeys = [
  "apiKey",
  "authToken",
  "baseURL",
  "headers",
  "enterpriseUrl",
  // provider.ts:357-359 — Bedrock endpoint becomes providerOptions.baseURL
  "endpoint",
  // provider.ts:876,894 — Snowflake Cortex token becomes the bearer apiKey
  "token",
  // provider.ts:892 — Snowflake account is interpolated into the request host
  "account",
  // provider.ts:246 + @ai-sdk/azure dist:99 — interpolated into the azure host
  "resourceName",
  // provider.ts:99,523 + @ai-sdk/google-vertex dist:851 — interpolated into the vertex host
  "location",
  // provider.ts:301,344 + @ai-sdk/amazon-bedrock dist:2292 — interpolated into the aws host
  "region",
  // provider.ts:621-625,638 — merged verbatim into GitLab AI Gateway request headers
  "aiGatewayHeaders",
] as const

/**
 * Strip credential- and redirect-bearing provider fields and environment
 * escalation from an untrusted (project-repo) config. Returns the sanitized
 * copy plus the removed key paths so callers can log what was stripped.
 */
export function sanitizeProjectConfig(info: Info): { info: Info; stripped: string[] } {
  const stripped: string[] = []
  let next = info
  if (info.provider !== undefined) next = { ...next, provider: sanitizeProjectProviders(info.provider, stripped) }
  if (info.mcp !== undefined) next = { ...next, mcp: sanitizeProjectMcp(info.mcp, stripped) }
  if (info.experimental !== undefined)
    next = { ...next, experimental: sanitizeProjectExperimental(info.experimental, stripped) }
  return { info: next, stripped }
}

function sanitizeProjectProviders(provider: NonNullable<Info["provider"]>, stripped: string[]) {
  const next: Record<string, NonNullable<Info["provider"]>[string]> = {}
  for (const [id, entry] of Object.entries(provider)) {
    const copy = { ...entry }
    if (copy.api !== undefined) {
      stripped.push(`provider.${id}.api`)
      delete copy.api
    }
    // `provider.<id>.npm` selects an arbitrary SDK package: provider.ts feeds
    // it into apiNpm (provider.ts:1442-1445) and later installs it with
    // Npm.add plus a dynamic import (provider.ts:1794-1809). A repo must not
    // choose which package gets installed and imported.
    if (copy.npm !== undefined) {
      stripped.push(`provider.${id}.npm`)
      delete copy.npm
    }
    if (isRecord(copy.options)) {
      const options: Record<string, unknown> = { ...copy.options }
      for (const key of providerCredentialOptionKeys) {
        if (!(key in options)) continue
        stripped.push(`provider.${id}.options.${key}`)
        delete options[key]
      }
      copy.options = options as typeof copy.options
    }
    if (isRecord(copy.models)) copy.models = sanitizeProviderModels(id, copy.models, stripped)
    next[id] = copy
  }
  return next
}

// Project sources must not escalate environment inheritance: `inheritEnv` on a
// local (stdio) MCP entry hands the complete parent environment — including
// secret env vars — to a repo-chosen command.
function sanitizeProjectMcp(mcp: NonNullable<Info["mcp"]>, stripped: string[]) {
  const next: NonNullable<Info["mcp"]> = {}
  for (const [name, server] of Object.entries(mcp)) {
    if (!isRecord(server)) {
      next[name] = server
      continue
    }
    const copy: Record<string, unknown> = { ...server }
    if (copy.type !== "local" || copy.inheritEnv !== true) {
      next[name] = server
      continue
    }
    stripped.push(`mcp.${name}.inheritEnv`)
    delete copy.inheritEnv
    next[name] = copy as (typeof mcp)[string]
  }
  return next
}

// `experimental.openTelemetry` turns on OTel spans for AI SDK calls
// (session/llm.ts, agent/agent.ts): prompt and completion contents get
// exported as telemetry to the user's env-configured OTLP endpoint. Only the
// user may flip that switch. `experimental.policies` are permission-adjacent:
// policy statements can allow actions on resources (core/policy.ts evaluate),
// so project sources must not grant. The other experimental toggles
// (primary_tools, continue_loop_on_deny, mcp_timeout, disable_paste_summary,
// batch_tool) carry no permission or prompt-egress path, so they pass through.
function sanitizeProjectExperimental(experimental: NonNullable<Info["experimental"]>, stripped: string[]) {
  const copy = { ...experimental }
  if (copy.openTelemetry === undefined && copy.policies === undefined) return experimental
  if (copy.openTelemetry !== undefined) {
    stripped.push("experimental.openTelemetry")
    delete copy.openTelemetry
  }
  // Policies are permission-adjacent; project sources must not grant.
  if (copy.policies !== undefined) {
    stripped.push("experimental.policies")
    delete copy.policies
  }
  return copy
}

// migrate.ts turns per-model `headers` into request headers and
// `models.<id>.provider.api` into the model-level api.url override — the same
// exfiltration surface as provider-level credentials. `models.<id>.provider.npm`
// rides the same arbitrary-package install+dynamic-import path as
// `provider.<id>.npm` (see sanitizeProjectProviders).
function sanitizeProviderModels(
  providerID: string,
  models: Record<string, ProviderModelInfo>,
  stripped: string[],
) {
  const next: Record<string, ProviderModelInfo> = {}
  for (const [modelID, model] of Object.entries(models)) {
    if (!isRecord(model)) {
      next[modelID] = model
      continue
    }
    const copy = { ...model }
    if (copy.headers !== undefined) {
      stripped.push(`provider.${providerID}.models.${modelID}.headers`)
      delete copy.headers
    }
    if (isRecord(copy.provider)) {
      const override = { ...copy.provider }
      if (override.api !== undefined) {
        stripped.push(`provider.${providerID}.models.${modelID}.provider.api`)
        delete override.api
      }
      if (override.npm !== undefined) {
        stripped.push(`provider.${providerID}.models.${modelID}.provider.npm`)
        delete override.npm
      }
      copy.provider = override as typeof copy.provider
    }
    next[modelID] = copy
  }
  return next
}

/**
 * Find a repo-controlled `.npmrc` between `dir` (inclusive) and `stop`
 * (inclusive — the worktree root is repo territory). npm reads per-directory
 * `.npmrc` files by walking up from its cwd, so one on this path can redirect
 * the automatic `@ranex/plugin` install.
 */
export function findProjectNpmrc(dir: string, stop: string): string | undefined {
  let current = path.resolve(dir)
  const limit = path.resolve(stop)
  while (FSUtil.contains(limit, current)) {
    const candidate = path.join(current, ".npmrc")
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

// Config dirs the user owns directly: global config, ~/.opencode, and an
// explicit RANEX_CONFIG_DIR. Everything else inside the project boundary is
// repo-controlled.
function trustedConfigDir(dir: string) {
  return dir === Global.Path.config || dir === Flag.RANEX_CONFIG_DIR || dir === path.join(Global.Path.home, ".opencode")
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

type Info = ConfigV1.Info

type ProviderInfo = NonNullable<Info["provider"]>[string]

type ProviderModelInfo = NonNullable<ProviderInfo["models"]>[string]

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

export const use = serviceUse(Service)

function globalConfigFile() {
  const candidates = ["ranex.jsonc", "ranex.json", "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  return info
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      const body = yield* response.text.pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
      untrusted?: boolean,
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env, untrusted }
            : { text, type: "virtual", ...options, env, untrusted },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(parsed), source)
      ConfigPluginV1.assertDisabled(data.plugin, source, "plugin")
      if (!("path" in options)) return data

      if (!data.$schema) {
        data.$schema = "https://opencode.ai/config.json"
        const updated = text.replace(/^\s*\{/, '{\n  "$schema": "https://opencode.ai/config.json",')
        yield* fs.writeFileString(options.path, updated).pipe(Effect.catch(() => Effect.void))
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>, untrusted?: boolean) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env, untrusted)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.RANEX_CONFIG && !Flag.RANEX_CONFIG_DIR && !Flag.RANEX_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* fs
            .writeWithDirs(file, JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2))
            .pipe(Effect.catch(() => Effect.void))
        }
      }
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "ranex.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "ranex.jsonc"), env))

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        const config = yield* Effect.promise(() => Bun.file(legacy).text().then(Bun.TOML.parse).catch(() => undefined))
        if (config) {
          const { provider, model, ...rest } = config as {
            provider?: string
            model?: string
            plugin?: readonly unknown[]
          }
          try {
            ConfigPluginV1.assertDisabled(rest.plugin, legacy, "plugin")
          } catch (error) {
            if (ConfigErrorV1.InvalidError.isInstance(error)) yield* Effect.fail(error)
            throw error
          }
          if (provider && model) result.model = `${provider}/${model}`
          result["$schema"] = "https://opencode.ai/config.json"
          result = mergeConfig(result, rest as Info)
          yield* Effect.promise(async () => {
            await fsNode.writeFile(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
            await fsNode.unlink(legacy)
          }).pipe(Effect.catch(() => Effect.void))
        }
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.catch((error) => {
          if (ConfigErrorV1.InvalidError.isInstance(error)) return Effect.die(error)
          return Effect.succeed({} as Info)
        }),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      yield* fs.ensureDir(dir)
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const merge = Effect.fnUntraced(function* (source: string, next: Info, kind?: "global" | "local") {
          if (kind !== "local") {
            result = mergeConfigConcatArrays(result, next)
            return
          }
          const sanitized = sanitizeProjectConfig(next)
          if (sanitized.stripped.length) {
            yield* Effect.logWarning("stripped credential-bearing provider options from untrusted project config", {
              source,
              stripped: sanitized.stripped,
            })
          }
          result = mergeConfigConcatArrays(result, sanitized.info)
        })

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/opencode`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url)
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://opencode.ai/config.json"
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (Flag.RANEX_CONFIG) {
          yield* merge(Flag.RANEX_CONFIG, yield* loadFile(Flag.RANEX_CONFIG, authEnv))
          yield* Effect.logDebug("loaded custom config", { path: Flag.RANEX_CONFIG })
        }

        if (!Flag.RANEX_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("ranex", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, yield* loadFile(file, authEnv, true), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const configContent = process.env.RANEX_CONFIG_CONTENT
          ? yield* loadConfig(process.env.RANEX_CONFIG_CONTENT, {
              dir: ctx.directory,
              source: "RANEX_CONFIG_CONTENT",
            })
          : undefined
        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        const accountConfig = activeAccount?.active_org_id
          ? yield* Effect.gen(function* () {
              const accountID = activeAccount.id
              const orgID = activeAccount.active_org_id
              if (!orgID) return
              const url = activeAccount.url
              const [configOpt, tokenOpt] = yield* Effect.all(
                [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
                { concurrency: 2 },
              )
              if (Option.isSome(tokenOpt)) {
                process.env["RANEX_CONSOLE_TOKEN"] = tokenOpt.value
                yield* env.set("RANEX_CONSOLE_TOKEN", tokenOpt.value)
              }
              if (Option.isNone(configOpt)) return

              const source = `${url}/api/config`
              return { source, config: configOpt.value }
            }).pipe(
              Effect.withSpan("Config.loadActiveOrgConfig"),
              Effect.catch((err) =>
                Effect.logDebug("failed to fetch remote account config", {
                  error: err instanceof Error ? err.message : String(err),
                }),
              ),
            )
          : undefined
        const loadedAccountConfig = accountConfig
          ? yield* Effect.gen(function* () {
              const next = yield* loadConfig(JSON.stringify(accountConfig.config), {
                dir: path.dirname(accountConfig.source),
                source: accountConfig.source,
              })
              return { source: accountConfig.source, next, providerIDs: Object.keys(next.provider ?? {}) }
            })
          : undefined
        const managedDir = ConfigManaged.managedConfigDir()
        const managedConfigs = existsSync(managedDir)
          ? yield* Effect.forEach(["ranex.json", "ranex.jsonc"], (file) => {
              const source = path.join(managedDir, file)
              return Effect.map(loadFile(source), (next) => ({ source, next }))
            })
          : []
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        const managedConfig = managed
          ? yield* loadConfig(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            })
          : undefined

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.RANEX_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from RANEX_CONFIG_DIR", { path: Flag.RANEX_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          if (dir.endsWith(".opencode") || dir === Flag.RANEX_CONFIG_DIR) {
            const untrusted = !trustedConfigDir(dir) && containsPath(dir, ctx)
            for (const file of ["ranex.json", "ranex.jsonc"]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              // Repo-controlled .opencode dirs merge as "local" so the
              // project-config sanitize pass applies to them too.
              yield* merge(source, yield* loadFile(source, authEnv, untrusted), untrusted ? "local" : undefined)
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          const npmrc = trustedConfigDir(dir) ? undefined : findProjectNpmrc(dir, ctx.worktree)
          if (npmrc) {
            yield* Effect.logWarning("skipping @ranex/plugin install: project .npmrc may redirect npm", {
              dir,
              npmrc,
            })
          } else {
            const dep = yield* npmSvc
              .install(dir, {
                add: [
                  {
                    name: "@ranex/plugin",
                    version: InstallationLocal ? undefined : InstallationVersion,
                  },
                ],
              })
              .pipe(
                Effect.exit,
                Effect.tap((exit) =>
                  Exit.isFailure(exit)
                    ? Effect.logWarning("background dependency install failed", { dir, error: String(exit.cause) })
                    : Effect.void,
                ),
                Effect.asVoid,
                Effect.forkDetach,
              )
            deps.push(dep)
          }

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
        }

        if (configContent) {
          // Env-provided content is user-initiated (trusted): merged without the "local" kind.
          yield* merge("RANEX_CONFIG_CONTENT", configContent)
          yield* Effect.logDebug("loaded custom config from RANEX_CONFIG_CONTENT")
        }

        if (loadedAccountConfig) {
          for (const providerID of loadedAccountConfig.providerIDs) {
            consoleManagedProviders.add(providerID)
          }
          yield* merge(loadedAccountConfig.source, loadedAccountConfig.next, "global")
        }

        for (const managedConfig of managedConfigs) {
          yield* merge(managedConfig.source, managedConfig.next, "global")
        }

        if (managedConfig) {
          result = mergeConfigConcatArrays(result, managedConfig)
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.RANEX_PERMISSION) {
          try {
            result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.RANEX_PERMISSION))
          } catch (err) {
            yield* Effect.logWarning("RANEX_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        if (Flag.RANEX_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.RANEX_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        return {
          config: result,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file, undefined, true)
      yield* fs
        .writeFileString(file, JSON.stringify(mergeDeep(writable(existing), writable(config)), null, 2))
        .pipe(Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      const file = globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"
      const patch = writableGlobal(config)

      let next: Info
      let changed: boolean
      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(before, file), file)
        const merged = mergeDeep(writable(existing), patch)
        const serialized = JSON.stringify(merged, null, 2)
        changed = serialized !== before
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
        next = merged
      } else {
        const updated = patchJsonc(before, patch)
        next = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(updated, file), file)
        changed = updated !== before
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      if (changed) yield* invalidate()
      return { info: next, changed }
    })

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Auth.node, Account.node, Env.node, Npm.node, httpClient],
})

export * as Config from "./config"
