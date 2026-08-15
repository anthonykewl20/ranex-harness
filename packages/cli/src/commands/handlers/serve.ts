import { NodeHttpServer } from "@effect/platform-node"
import { Credential } from "@ranex/core/credential"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { PermissionSaved } from "@ranex/core/permission/saved"
import { Context, Layer, Option } from "effect"
import * as Effect from "effect/Effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:http"
import { createRoutes } from "@ranex/server/routes"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Daemon } from "../../services/daemon"

export default Runtime.handler(
  Commands.commands.serve,
  Effect.fn("cli.serve")(function* (input) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const daemon = yield* Daemon.Service
        const password = yield* daemon.password()
        yield* ensureAuthenticatedBind(input.hostname, password)
        const address = yield* listen(input.hostname, input.port, password)
        if (input.register) yield* daemon.register(address)
        console.log(`server listening on ${HttpServer.formatAddress(address)}`)
        return yield* Effect.never
      }),
    )
  }),
)

function isLoopbackBind(hostname: string) {
  const bare = hostname.toLowerCase()
  const unbracketed = bare.startsWith("[") && bare.endsWith("]") ? bare.slice(1, -1) : bare
  if (unbracketed === "localhost" || unbracketed === "127.0.0.1" || unbracketed === "::1") return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(unbracketed)
}

// A non-loopback bind without an authenticated route stack exposes an unauthenticated
// server to the network; refuse it instead of warning, mirroring ranex network.ts. The
// routes here are authenticated with the daemon password, which gate on.
export function ensureAuthenticatedBind(hostname: string, password: string) {
  if (isLoopbackBind(hostname) || password !== "") return Effect.void
  return Effect.fail(
    new Error(
      `Refusing to listen on ${hostname} without authentication: set a service password (lildax service password) or bind a loopback hostname (e.g. --hostname 127.0.0.1)`,
    ),
  )
}

function listen(hostname: string, port: Option.Option<number>, password: string) {
  if (Option.isSome(port)) return bind(hostname, port.value, password)
  const next = (port: number): ReturnType<typeof bind> =>
    bind(hostname, port, password).pipe(
      Effect.catch((error) => (port === 65_535 ? Effect.fail(error) : next(port + 1))),
    )
  return next(4096)
}

function bind(hostname: string, port: number, password: string) {
  return Layer.build(
    HttpRouter.serve(createRoutes(password), { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port, host: hostname })),
      Layer.provide(AppNodeBuilder.build(LayerNode.group([Credential.node, PermissionSaved.node]))),
    ),
  ).pipe(Effect.map((context) => Context.get(context, HttpServer.HttpServer).address))
}
