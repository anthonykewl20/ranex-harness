import { afterEach, describe, expect, test } from "bun:test"
import { EventV2 } from "@ranex/core/event"
import { Database } from "@ranex/core/database/database"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Location } from "@ranex/core/location"
import { SessionV2 } from "@ranex/core/session"
import { Global } from "@ranex/core/global"
import { MANAGED_DIRECTORY } from "@ranex/core/tool-output-store"
import { ManagedOutput } from "@ranex/schema/managed-output"
import { ServerEvent } from "@ranex/schema/server-event"
import { EventStreamGeneration } from "@ranex/server/event-stream-generation"
import { SessionEvent } from "@ranex/core/session/event"
import { SessionMessage } from "@ranex/core/session/message"
import { Context, DateTime, Effect, Schema } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { mkdir, rm } from "node:fs/promises"
import path from "path"
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

async function createSession(directory: string) {
  const response = await request("/api/session", directory, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: { directory } }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { data: { id: string } }
}

const Event = Schema.Struct({
  id: EventV2.ID,
  type: Schema.String,
  location: Schema.optional(Location.Ref),
  data: Schema.Unknown,
  truncated: Schema.optional(Schema.Boolean),
  payloadID: Schema.optional(EventV2.ID),
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
  test("rejects relative event subscription directories", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await request("/api/event?directory=relative", tmp.path)
    expect(response.status).toBe(400)
  })

  test("rejects invalid event subscription client IDs", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await request("/api/event?clientID=not%20valid", tmp.path)
    expect(response.status).toBe(400)
  })

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

  eventIt.live("supersedes an older tracked SSE generation and releases both listeners", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const listenerCount = events.listenerCount()
      const diagnostics = EventStreamGeneration.diagnostics(events)
      const first = eventStream(
        (yield* Effect.promise(() => request(`/api/event?clientID=primary`, process.cwd()))).body!,
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => first.return(undefined)).pipe(Effect.asVoid))
      expect((yield* Effect.promise(() => readEvent(first))).type).toBe("server.connected")
      const second = eventStream(
        (yield* Effect.promise(() => request(`/api/event?clientID=primary`, process.cwd()))).body!,
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => second.return(undefined)).pipe(Effect.asVoid))
      expect((yield* Effect.promise(() => readEvent(second))).type).toBe("server.connected")
      expect((yield* Effect.promise(() => readEvent(first))).type).toBe("server.superseded")
      expect((yield* Effect.promise(() => first.next())).done).toBe(true)
      yield* pollWithTimeout(
        Effect.sync(() => {
          const current = EventStreamGeneration.diagnostics(events)
          return events.listenerCount() === listenerCount + 1 &&
            events.diagnostics().activeSubscribers === 1 &&
            current.activeGenerations === 1 &&
            current.supersededStreams === diagnostics.supersededStreams + 1
            ? true
            : undefined
        }),
        "superseded SSE generation did not release",
      )
      yield* Effect.promise(() => second.return(undefined))
      yield* pollWithTimeout(
        Effect.sync(() => {
          const current = EventStreamGeneration.diagnostics(events)
          return events.listenerCount() === listenerCount &&
            events.diagnostics().activeSubscribers === 0 &&
            current.activeGenerations === diagnostics.activeGenerations
            ? true
            : undefined
        }),
        "tracked SSE generation did not release",
      )
    }),
  )

  eventIt.live("supersedes a tracked location-scoped SSE generation", () =>
    Effect.gen(function* () {
      const route = `/api/event?clientID=scoped&directory=${encodeURIComponent(process.cwd())}`
      const first = eventStream((yield* Effect.promise(() => request(route, process.cwd()))).body!)
      yield* Effect.addFinalizer(() => Effect.promise(() => first.return(undefined)).pipe(Effect.asVoid))
      expect((yield* Effect.promise(() => readEvent(first))).type).toBe("server.connected")
      const second = eventStream((yield* Effect.promise(() => request(route, process.cwd()))).body!)
      yield* Effect.addFinalizer(() => Effect.promise(() => second.return(undefined)).pipe(Effect.asVoid))
      expect((yield* Effect.promise(() => readEvent(second))).type).toBe("server.connected")
      expect((yield* Effect.promise(() => readEvent(first))).type).toBe("server.superseded")
      yield* Effect.promise(() => second.return(undefined))
    }),
  )

  eventIt.live("does not deregister a tracked SSE successor when its superseded predecessor closes", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const first = eventStream(
        (yield* Effect.promise(() => request(`/api/event?clientID=successor`, process.cwd()))).body!,
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => first.return(undefined)).pipe(Effect.asVoid))
      expect((yield* Effect.promise(() => readEvent(first))).type).toBe("server.connected")
      const second = eventStream(
        (yield* Effect.promise(() => request(`/api/event?clientID=successor`, process.cwd()))).body!,
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => second.return(undefined)).pipe(Effect.asVoid))
      expect((yield* Effect.promise(() => readEvent(second))).type).toBe("server.connected")
      expect((yield* Effect.promise(() => readEvent(first))).type).toBe("server.superseded")
      yield* Effect.promise(() => first.return(undefined))
      const published = yield* events.publish(ServerEvent.Disposed, {})
      expect(yield* Effect.promise(() => readEvent(second))).toMatchObject({ id: published.id, type: "global.disposed" })
      expect(EventStreamGeneration.diagnostics(events).activeGenerations).toBe(1)
      yield* Effect.promise(() => second.return(undefined))
    }),
  )

  eventIt.live("atomically keeps one tracked SSE generation in a concurrent registration race", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const baseline = EventStreamGeneration.diagnostics(events)
      const superseded = { count: 0 }
      const first = { close: Effect.sync(() => void superseded.count++) }
      const second = { close: Effect.sync(() => void superseded.count++) }
      yield* Effect.all(
        [
          EventStreamGeneration.register(events, "race", first),
          EventStreamGeneration.register(events, "race", second),
        ],
        { concurrency: "unbounded" },
      )
      expect(superseded.count).toBe(1)
      expect(EventStreamGeneration.diagnostics(events)).toEqual({
        supersededStreams: baseline.supersededStreams + 1,
        activeGenerations: baseline.activeGenerations + 1,
      })
      yield* EventStreamGeneration.deregister(events, "race", first)
      expect(EventStreamGeneration.diagnostics(events).activeGenerations).toBe(baseline.activeGenerations + 1)
      yield* EventStreamGeneration.deregister(events, "race", second)
      expect(EventStreamGeneration.diagnostics(events)).toEqual({
        supersededStreams: baseline.supersededStreams + 1,
        activeGenerations: baseline.activeGenerations,
      })
    }),
  )

  eventIt.live("leaves untracked SSE streams independent", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const listenerCount = events.listenerCount()
      const generations = EventStreamGeneration.diagnostics(events)
      const first = eventStream((yield* Effect.promise(() => request("/api/event", process.cwd()))).body!)
      const second = eventStream((yield* Effect.promise(() => request("/api/event", process.cwd()))).body!)
      yield* Effect.addFinalizer(() => Effect.promise(() => first.return(undefined)).pipe(Effect.asVoid))
      yield* Effect.addFinalizer(() => Effect.promise(() => second.return(undefined)).pipe(Effect.asVoid))
      expect((yield* Effect.promise(() => readEvent(first))).type).toBe("server.connected")
      expect((yield* Effect.promise(() => readEvent(second))).type).toBe("server.connected")
      expect(EventStreamGeneration.diagnostics(events)).toEqual(generations)
      expect(events.listenerCount()).toBe(listenerCount + 2)
      yield* Effect.promise(() => Promise.all([first.return(undefined), second.return(undefined)]))
      yield* pollWithTimeout(
        Effect.sync(() =>
          events.listenerCount() === listenerCount && events.diagnostics().activeSubscribers === 0 ? true : undefined,
        ),
        "untracked SSE listeners did not release",
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

  eventIt.live("projects durable events in session replays and returns their canonical payloads", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const test = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => test[Symbol.asyncDispose]()))
      const session = yield* Effect.promise(() => createSession(test.path))
      const content = "a".repeat(9 * 1024)
      const published = yield* events.publish(SessionEvent.Tool.Success, {
        sessionID: SessionV2.ID.make(session.data.id),
        timestamp: DateTime.makeUnsafe(Date.now()),
        assistantMessageID: SessionMessage.ID.create(),
        callID: "call_payload",
        structured: { content },
        content: [],
        provider: { executed: false },
      })

      const stream = yield* Effect.promise(() => request(`/api/session/${session.data.id}/event`, test.path))
      expect(stream.status).toBe(200)
      const reader = eventStream(stream.body!)
      yield* Effect.addFinalizer(() => Effect.promise(() => reader.return(undefined)).pipe(Effect.asVoid))
      const projected = yield* Effect.promise(() => readEvent(reader))
      expect(projected).toMatchObject({ id: published.id, truncated: true, payloadID: published.id })

      const payload = yield* Effect.promise(() =>
        request(`/api/session/${session.data.id}/event/${published.id}/payload`, test.path),
      )
      expect(payload.status).toBe(200)
      expect(yield* Effect.promise(() => payload.json())).toEqual({
        data: Schema.encodeUnknownSync(SessionEvent.Durable)(published),
      })

      const nonDurable = yield* events.publish(ServerEvent.Connected, {})
      const missingPayload = yield* Effect.promise(() =>
        request(`/api/session/${session.data.id}/event/${nonDurable.id}/payload`, test.path),
      )
      expect(missingPayload.status).toBe(404)
      expect(yield* Effect.promise(() => missingPayload.json())).toMatchObject({ _tag: "EventPayloadNotFoundError" })
    }),
  )

  eventIt.live("serves managed tool outputs only to their owning session", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const test = yield* Effect.promise(() => tmpdir({ git: true }))
      yield* Effect.addFinalizer(() => Effect.promise(() => test[Symbol.asyncDispose]()))
      const owner = yield* Effect.promise(() => createSession(test.path))
      const other = yield* Effect.promise(() => createSession(test.path))
      const outputID = ManagedOutput.ID.create()
      const outputPath = path.join(Global.Path.data, MANAGED_DIRECTORY, `test-${outputID}`)
      yield* Effect.promise(() => mkdir(path.dirname(outputPath), { recursive: true }))
      yield* Effect.promise(() => Bun.write(outputPath, "complete output"))
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(outputPath, { force: true })))
      yield* events.publish(SessionEvent.Tool.Success, {
        sessionID: SessionV2.ID.make(owner.data.id),
        timestamp: DateTime.makeUnsafe(Date.now()),
        assistantMessageID: SessionMessage.ID.create(),
        callID: "call_output",
        structured: {},
        content: [],
        outputPaths: [outputPath],
        outputRefs: [outputID],
        provider: { executed: false },
      })

      const hit = yield* Effect.promise(() => request(`/api/session/${owner.data.id}/tool-output/${outputID}`, test.path))
      expect(hit.status).toBe(200)
      expect(yield* Effect.promise(() => hit.text())).toBe("complete output")

      const missing = yield* Effect.promise(() =>
        request(`/api/session/${owner.data.id}/tool-output/${ManagedOutput.ID.create()}`, test.path),
      )
      expect(missing.status).toBe(404)
      expect(yield* Effect.promise(() => missing.json())).toMatchObject({ _tag: "ManagedOutputNotFoundError" })

      const crossSession = yield* Effect.promise(() =>
        request(`/api/session/${other.data.id}/tool-output/${outputID}`, test.path),
      )
      expect(crossSession.status).toBe(404)
      expect(yield* Effect.promise(() => crossSession.json())).toMatchObject({ _tag: "ManagedOutputNotFoundError" })

      const pathShaped = yield* Effect.promise(() =>
        request(`/api/session/${owner.data.id}/tool-output/out_%2Fetc%2Fpasswd`, test.path),
      )
      expect(pathShaped.status).toBe(400)

      const expiredID = ManagedOutput.ID.create()
      yield* events.publish(SessionEvent.Tool.Success, {
        sessionID: SessionV2.ID.make(owner.data.id),
        timestamp: DateTime.makeUnsafe(0),
        assistantMessageID: SessionMessage.ID.create(),
        callID: "call_expired_match",
        structured: {},
        content: [],
        outputPaths: [outputPath],
        outputRefs: [expiredID],
        provider: { executed: false },
      })
      const expired = yield* Effect.promise(() =>
        request(`/api/session/${owner.data.id}/tool-output/${expiredID}`, test.path),
      )
      expect(expired.status).toBe(410)
      expect(yield* Effect.promise(() => expired.json())).toMatchObject({ _tag: "ManagedOutputExpiredError" })

      const externalID = ManagedOutput.ID.create()
      yield* events.publish(SessionEvent.Tool.Success, {
        sessionID: SessionV2.ID.make(owner.data.id),
        timestamp: DateTime.makeUnsafe(Date.now()),
        assistantMessageID: SessionMessage.ID.create(),
        callID: "call_external_path",
        structured: {},
        content: [],
        outputPaths: ["/etc/passwd"],
        outputRefs: [externalID],
        provider: { executed: false },
      })
      const external = yield* Effect.promise(() =>
        request(`/api/session/${owner.data.id}/tool-output/${externalID}`, test.path),
      )
      expect(external.status).toBe(410)
      expect(yield* Effect.promise(() => external.json())).toMatchObject({ _tag: "ManagedOutputExpiredError" })
    }),
  )
})
