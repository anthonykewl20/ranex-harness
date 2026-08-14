import { Global } from "@ranex/core/global"
import { InstallationVersion } from "@ranex/core/installation/version"
import { createOpencodeClient } from "@ranex/sdk/v2/client"
import { ServerAuth } from "@ranex/server/auth"
import { Context, Effect, FileSystem, Layer, Option, Schedule, Schema, Scope } from "effect"
import { HttpServer } from "effect/unstable/http"
import { randomBytes, randomUUID } from "crypto"
import { spawn } from "node:child_process"
import { readFileSync, readlinkSync } from "node:fs"
import path from "path"

export interface Interface {
  readonly client: () => Effect.Effect<ReturnType<typeof createOpencodeClient>, unknown>
  readonly transport: () => Effect.Effect<{ url: string; headers: RequestInit["headers"] }, unknown>
  readonly start: () => Effect.Effect<string, Error>
  readonly restart: () => Effect.Effect<string, Error>
  readonly status: () => Effect.Effect<string | undefined>
  readonly stop: () => Effect.Effect<void, unknown>
  readonly password: (value?: string) => Effect.Effect<string, unknown>
  readonly register: (address: HttpServer.Address) => Effect.Effect<void, unknown, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/Daemon") {}

const Ownership = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  executable: Schema.String,
  starttime: Schema.String,
})
type Ownership = typeof Ownership.Type

const Registration = Schema.Struct({
  id: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  url: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  ownership: Schema.optional(Ownership),
})
type Registration = typeof Registration.Type

function sameRegistration(left: Registration, right: Registration) {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.url === right.url &&
    left.pid === right.pid &&
    left.ownership?.executable === right.ownership?.executable &&
    left.ownership?.starttime === right.ownership?.starttime
  )
}

export function isReplacement(incumbent: Pick<Registration, "id" | "pid">, replacement: Pick<Registration, "id" | "pid">) {
  return replacement.id !== undefined && incumbent.id !== replacement.id && incumbent.pid !== replacement.pid
}

function sameOwnership(registration: Registration) {
  const current = processOwnership(registration.pid)
  return (
    registration.ownership !== undefined &&
    current !== undefined &&
    registration.ownership.pid === current.pid &&
    registration.ownership.executable === current.executable &&
    registration.ownership.starttime === current.starttime
  )
}

function processOwnership(pid: number): Ownership | undefined {
  if (process.platform !== "linux") return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)
    const starttime = fields[19]
    if (starttime === undefined) return undefined
    return { pid, executable: readlinkSync(`/proc/${pid}/exe`), starttime }
  } catch {
    return undefined
  }
}

function isMissingProcess(cause: unknown) {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH"
}

function isMissingFile(cause: unknown) {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = Global.Path.state
    const file = path.join(directory, "server.json")
    const passwordFile = path.join(directory, "password")
    const decodeRegistration = Schema.decodeUnknownEffect(Schema.fromJsonString(Registration))

    const password = Effect.fn("cli.daemon.password")(function* (value?: string) {
      const existing = yield* fs.readFileString(passwordFile).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (value === undefined && existing) return existing

      // Keep one private credential across server restarts so discovered clients
      // can reconnect without exposing a password flag or environment variable.
      const generated = value ?? randomBytes(32).toString("base64url")
      const temp = passwordFile + ".tmp"
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.writeFileString(temp, generated, { mode: 0o600 })
      yield* fs.rename(temp, passwordFile)
      return generated
    })

    const registration = Effect.fnUntraced(function* () {
      return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeRegistration))
    })

    const createClient = Effect.fnUntraced(function* (url: string) {
      return createOpencodeClient({ baseUrl: url, headers: ServerAuth.headers({ password: yield* password() }) })
    })

    const healthy = Effect.fnUntraced(function* () {
      const info = yield* registration()
      yield* probe(info)
      return info
    })

    const probe = Effect.fnUntraced(function* (info: Registration) {
      const client = yield* createClient(info.url)
      const response = yield* Effect.tryPromise(() => client.v2.health.get({ signal: AbortSignal.timeout(2_000) }))
      if (response.data?.healthy === true) return info
      return yield* Effect.fail(new Error("Registered server is not healthy"))
    })

    const compatible = Effect.fnUntraced(function* () {
      const info = yield* healthy()
      if (info.version === InstallationVersion) return info
      return yield* Effect.fail(new Error("Registered server version does not match the client"))
    })

    const signal = (pid: number, signal: NodeJS.Signals) =>
      Effect.try({ try: () => process.kill(pid, signal), catch: (cause) => cause }).pipe(Effect.ignore)

    const signalReplacement = (pid: number, value: NodeJS.Signals) =>
      Effect.try({
        try: () => process.kill(pid, value),
        catch: (cause) => new Error(`Failed to send ${value} to registered service process ${pid}`, { cause }),
      })

    const awaitStopped = Effect.fnUntraced(function* (pid: number) {
      const running = yield* Effect.try({
        try: () => {
          process.kill(pid, 0)
          return true
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          isMissingProcess(cause)
            ? Effect.succeed(false)
            : Effect.fail(new Error(`Unable to verify registered service process ${pid}`, { cause })),
        ),
      )
      if (!running) return true
      return yield* Effect.fail(new Error(`Server process ${pid} is still running`))
    })

    const stopProcess = Effect.fnUntraced(function* (info: Registration) {
      const current = yield* healthy().pipe(Effect.option)
      if (Option.isNone(current) || !sameRegistration(current.value, info)) return

      yield* signal(info.pid, "SIGTERM")
      const stopped = yield* awaitStopped(info.pid).pipe(
        Effect.retry(Schedule.spaced("50 millis").pipe(Schedule.both(Schedule.recurs(100)))),
        Effect.option,
      )
      if (Option.isSome(stopped)) return

      const latest = yield* healthy().pipe(Effect.option)
      if (Option.isNone(latest) || !sameRegistration(latest.value, info)) return
      yield* signal(info.pid, "SIGKILL")
      yield* awaitStopped(info.pid).pipe(
        Effect.retry(Schedule.spaced("50 millis").pipe(Schedule.both(Schedule.recurs(100)))),
      )
    })

    const removeRegistration = Effect.fnUntraced(function* (info: Registration) {
      const current = yield* registration().pipe(Effect.option)
      if (Option.isNone(current) || !sameRegistration(current.value, info)) return
      yield* fs.remove(file)
    })

    const start = Effect.fn("cli.daemon.start")(function* () {
      const existing = yield* healthy().pipe(Effect.option)
      const found = Option.getOrUndefined(existing)
      const compiled = path.basename(process.execPath).replace(/\.exe$/, "") !== "bun"
      if (found?.version === InstallationVersion && compiled) return found.url
      if (found) yield* stopProcess(found).pipe(Effect.ignore)

      const entrypoint = compiled ? undefined : process.argv[1]
      if (!compiled && entrypoint === undefined)
        return yield* Effect.fail(new Error("Failed to resolve CLI entrypoint"))
      yield* Effect.try({
        try: () => {
          spawn(process.execPath, [...(entrypoint ? [entrypoint] : []), "serve", "--register"], {
            detached: true,
            stdio: "ignore",
          }).unref()
        },
        catch: (cause) => new Error("Failed to start server", { cause }),
      })

      return yield* compatible().pipe(
        Effect.retry(Schedule.spaced("50 millis").pipe(Schedule.both(Schedule.recurs(100)))),
        Effect.map((info) => info.url),
        Effect.mapError(() => new Error("Failed to start server")),
      )
    })

    const startFresh = Effect.fnUntraced(function* (incumbent: Registration) {
      const compiled = path.basename(process.execPath).replace(/\.exe$/, "") !== "bun"
      const entrypoint = compiled ? undefined : process.argv[1]
      if (!compiled && entrypoint === undefined)
        return yield* Effect.fail(new Error("Failed to resolve CLI entrypoint for replacement service"))
      yield* Effect.try({
        try: () => {
          spawn(process.execPath, [...(entrypoint ? [entrypoint] : []), "serve", "--register"], {
            detached: true,
            stdio: "ignore",
          }).unref()
        },
        catch: (cause) => new Error("Failed to start replacement service", { cause }),
      })
      return yield* compatible().pipe(
        Effect.filterOrFail((info) => isReplacement(incumbent, info), () =>
          new Error(`Replacement service reused registered process ${incumbent.pid}`),
        ),
        Effect.retry(Schedule.spaced("50 millis").pipe(Schedule.both(Schedule.recurs(100)))),
        Effect.map((info) => info.url),
        Effect.mapError((cause) =>
          cause instanceof Error
            ? new Error(`Replacement service did not become healthy within 5 seconds: ${cause.message}`)
            : new Error("Replacement service did not become healthy within 5 seconds"),
        ),
      )
    })

    const restart = Effect.fn("cli.daemon.restart")(function* () {
      const incumbent = yield* registration().pipe(
        Effect.mapError((cause) =>
          isMissingFile(cause)
            ? new Error("Cannot restart service: no registered service was found. Run service start.")
            : new Error("Cannot restart service: the registered service is corrupt. Run service stop, then service start."),
        ),
      )
      if (incumbent.id === undefined)
        return yield* Effect.fail(
          new Error("Cannot restart service: the registered service has no instance identity. Run service stop, then service start."),
        )

      const alreadyStopped = yield* awaitStopped(incumbent.pid).pipe(Effect.option)
      if (Option.isNone(alreadyStopped)) {
        const authenticated = yield* probe(incumbent).pipe(Effect.option)
        if (Option.isNone(authenticated) && !sameOwnership(incumbent))
          return yield* Effect.fail(
            new Error(
              `Cannot restart service: registered process ${incumbent.pid} is unreachable and its ownership cannot be verified (${process.platform === "linux" ? "the Linux /proc fingerprint is unavailable or mismatched" : "verification is unsupported on this platform"}). The incumbent was not touched. Inspect the process, then run service stop and service start.`,
            ),
          )

        yield* signalReplacement(incumbent.pid, "SIGTERM")
        const stopped = yield* awaitStopped(incumbent.pid).pipe(
          Effect.retry(Schedule.spaced("50 millis").pipe(Schedule.both(Schedule.recurs(100)))),
          Effect.option,
        )
        if (Option.isNone(stopped)) {
          if (!sameOwnership(incumbent))
            return yield* Effect.fail(
              new Error(
                `Cannot restart service: registered process ${incumbent.pid} did not exit within 5 seconds after SIGTERM and its ownership changed. Inspect the process before retrying.`,
              ),
            )
          yield* signalReplacement(incumbent.pid, "SIGKILL")
          yield* awaitStopped(incumbent.pid).pipe(
            Effect.retry(Schedule.spaced("50 millis").pipe(Schedule.both(Schedule.recurs(100)))),
            Effect.mapError(
              () =>
                new Error(
                  `Cannot restart service: registered process ${incumbent.pid} did not exit within 5 seconds after SIGTERM and SIGKILL. Inspect the process before retrying.`,
                ),
            ),
          )
        }
      }

      yield* removeRegistration(incumbent)
      return yield* startFresh(incumbent)
    })

    const transport = Effect.fn("cli.daemon.transport")(function* () {
      return { url: yield* start(), headers: ServerAuth.headers({ password: yield* password() }) }
    })

    const client = Effect.fn("cli.daemon.client")(function* () {
      const connection = yield* transport()
      return createOpencodeClient({ baseUrl: connection.url, headers: connection.headers })
    })

    const status = Effect.fn("cli.daemon.status")(function* () {
      const existing = yield* healthy().pipe(Effect.option)
      const found = Option.getOrUndefined(existing)
      if (found?.version === InstallationVersion) return found.url
      if (found) return undefined
      yield* fs.remove(file).pipe(Effect.ignore)
      return undefined
    })

    const stop = Effect.fn("cli.daemon.stop")(function* () {
      const existing = yield* healthy().pipe(Effect.option)
      // A stale registration may point at a PID that has since been reused by
      // another process. Only signal the PID after authenticating the server.
      if (Option.isNone(existing)) return yield* fs.remove(file).pipe(Effect.ignore)
      yield* stopProcess(existing.value)
      yield* fs.remove(file).pipe(Effect.ignore)
    })

    const register = Effect.fn("cli.daemon.register")(function* (address: HttpServer.Address) {
      const id = randomUUID()
      const temp = file + "." + id + ".tmp"
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.writeFileString(
        temp,
        JSON.stringify({
          id,
          version: InstallationVersion,
          url: HttpServer.formatAddress(address),
          pid: process.pid,
          ownership: processOwnership(process.pid),
        }),
        { mode: 0o600 },
      )
      yield* fs.rename(temp, file)
      yield* registration().pipe(
        Effect.flatMap((info) => (info.id === id ? Effect.void : signal(process.pid, "SIGTERM"))),
        Effect.catch(() => signal(process.pid, "SIGTERM")),
        Effect.repeat(Schedule.spaced("10 seconds")),
        Effect.forkScoped,
      )
      yield* Effect.addFinalizer(() =>
        registration().pipe(
          Effect.flatMap((info) => (info.id === id ? fs.remove(file) : Effect.void)),
          Effect.ignore,
        ),
      )
    })

    return Service.of({ client, transport, start, restart, status, stop, password, register })
  }),
)

export * as Daemon from "./daemon"
