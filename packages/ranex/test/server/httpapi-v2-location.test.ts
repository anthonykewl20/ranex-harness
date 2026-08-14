import { afterEach, describe, expect, test } from "bun:test"
import { EventV2 } from "@ranex/core/event"
import { Database } from "@ranex/core/database/database"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Location } from "@ranex/core/location"
import { ServerEvent } from "@ranex/schema/server-event"
import { Context, Effect, Schema } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout, testEffectShared } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>
const eventIt = testEffectShared(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const Event = Schema.Struct({
  id: EventV2.ID,
  type: Schema.String,
  location: Schema.optional(Location.Ref),
  data: Schema.Unknown,
})

async function* eventStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const boundary = buffer.match(/(?:\r\n|\r|\n){2}/)
      if (!boundary || boundary.index === undefined) {
        const value = await reader.read()
        if (value.done) return
        buffer += decoder.decode(value.value, { stream: true })
        continue
      }

      const record = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = record
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
      if (data.length) yield Schema.decodeUnknownSync(Event)(JSON.parse(data.join("\n")))
    }
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

async function readEvent(reader: AsyncIterator<typeof Event.Type>) {
  const value = await reader.next()
  if (value.done) throw new Error("event stream closed")
  return value.value
}

async function readEventType(reader: AsyncIterator<typeof Event.Type>, type: string) {
  for (let index = 0; index < 20; index++) {
    const event = await readEvent(reader)
    if (event.type === type) return event
  }
  throw new Error(`timed out waiting for ${type}`)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 location HttpApi", () => {
  test("decodes EventV2 location refs without resolved project metadata", () => {
    expect(
      Schema.decodeUnknownSync(Event)({
        id: "evt_test",
        type: "file.watcher.updated",
        location: { directory: "/tmp/project" },
        data: {},
      }),
    ).toMatchObject({ location: { directory: "/tmp/project" } })
  })

  test("returns command and skill snapshots with resolved locations", async () => {
    await using tmp = await tmpdir({ git: true })

    for (const route of ["/api/command", "/api/skill"]) {
      const response = await request(route, tmp.path)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        location: { directory: string; project: { id: string } }
        data: unknown
      }
      expect(body.data).toBeArray()
      expect(body.location.directory).toBe(tmp.path)
      expect(body.location.project.id).toBeTruthy()
    }
  })

  test("leaves native EventV2 streams unscoped without query parameters", async () => {
    await using subscriber = await tmpdir({ git: true })
    await using publisher = await tmpdir({ git: true })
    const response = await request("/api/event", subscriber.path)
    const reader = eventStream(response.body!)
    const connected = await readEvent(reader)
    expect(connected.type).toBe("server.connected")
    expect(connected.location).toBeUndefined()

    const created = await request("/session", publisher.path, { method: "POST" })
    expect(created.status).toBe(200)
    expect(await readEventType(reader, "session.created")).toMatchObject({
      type: "session.created",
      location: { directory: publisher.path },
      data: { sessionID: expect.any(String) },
    })
    await reader.return(undefined)
  })

  test("rejects a cross-location flood before it reaches a scoped EventV2 stream", async () => {
    await using subscriber = await tmpdir({ git: true })
    await using publisher = await tmpdir({ git: true })
    const response = await request(`/api/event?directory=${encodeURIComponent(subscriber.path)}`, subscriber.path)
    const reader = eventStream(response.body!)
    expect((await readEvent(reader)).type).toBe("server.connected")

    for (let index = 0; index < 300; index++) {
      expect((await request("/session", publisher.path, { method: "POST" })).status).toBe(200)
    }

    expect((await request("/session", subscriber.path, { method: "POST" })).status).toBe(200)
    expect(await readEventType(reader, "session.created")).toMatchObject({
      location: { directory: subscriber.path },
    })
    await reader.return(undefined)
  }, 30_000)

  test("sends server.connected and heartbeats to scoped EventV2 subscribers", async () => {
    await using subscriber = await tmpdir({ git: true })
    const response = await request(`/api/event?directory=${encodeURIComponent(subscriber.path)}`, subscriber.path)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let output = ""
    try {
      while (!output.includes(": heartbeat\n\n")) {
        const value = await reader.read()
        if (value.done) throw new Error("event stream closed before heartbeat")
        output += decoder.decode(value.value, { stream: true })
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    expect(output).toContain("server.connected")
  }, 30_000)

  eventIt.live("releases a scoped EventV2 listener when the SSE client disconnects", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const listenerCount = events.listenerCount()
      const activeSubscribers = events.diagnostics().activeSubscribers
      const response = yield* Effect.promise(() => request(`/api/event?directory=${encodeURIComponent(process.cwd())}`, process.cwd()))
      const reader = response.body!.getReader()
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await reader.cancel()
          reader.releaseLock()
        }),
      )
      const connected = yield* Effect.promise(() => reader.read())
      expect(new TextDecoder().decode(connected.value)).toContain("server.connected")
      yield* Effect.promise(() => reader.cancel())
      yield* pollWithTimeout(
        Effect.sync(() =>
          events.listenerCount() === listenerCount && events.diagnostics().activeSubscribers === activeSubscribers
            ? true
            : undefined,
        ),
        "scoped SSE listener did not release after client disconnect",
      )
    }),
  )

  eventIt.live("delivers location-less EventV2 events to scoped SSE subscribers", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const response = yield* Effect.promise(() => request(`/api/event?directory=${encodeURIComponent(process.cwd())}`, process.cwd()))
      const reader = eventStream(response.body!)
      yield* Effect.addFinalizer(() => Effect.promise(() => reader.return(undefined)).pipe(Effect.asVoid))
      expect((yield* Effect.promise(() => readEvent(reader))).type).toBe("server.connected")
      const published = yield* events.publish(ServerEvent.Connected, {})
      expect(yield* Effect.promise(() => readEvent(reader))).toMatchObject({
        id: published.id,
        type: ServerEvent.Connected.type,
      })
    }),
  )
})
