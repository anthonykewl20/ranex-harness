export * as ToolOutputStore from "./tool-output-store"

import path from "path"
import { appendFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { Config } from "./config"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { SessionSchema } from "./session/schema"
import { Identifier } from "./util/identifier"
import type { ToolOutput } from "@ranex/llm"
import { ManagedOutput } from "@ranex/schema/managed-output"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024
export const RETENTION = Duration.days(7)

export const MANAGED_DIRECTORY = "tool-output"

/** Hard cap on one command's fully-retained output (PM-4). Configurable via env because the
 *  tool_output config schema predates full retention; invalid values fall back to the default
 *  rather than silently disabling the cap. */
export const DEFAULT_FULL_RETENTION_MAX_BYTES = 20 * 1024 * 1024
const FULL_RETENTION_MAX_BYTES_ENV = "RANEX_TOOL_OUTPUT_RETENTION_MAX_BYTES"

export const RETENTION_TRUNCATION_MARKER_PREFIX = "[tool-output truncated at retention cap:"
export const RETENTION_INCOMPLETE_MARKER_PREFIX = "[tool-output incomplete:"
const INCOMPLETE_SUFFIX = ".incomplete"
/** Settled-but-unreferenced sink artifacts beyond this count are evicted (settle-less calls). */
const MAX_REMEMBERED_ARTIFACTS = 128

const fullRetentionMaxBytes = () => {
  const configured = Number(process.env[FULL_RETENTION_MAX_BYTES_ENV])
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_FULL_RETENTION_MAX_BYTES
}

export const retentionTruncationMarker = (cap: number, actualBytes: number, command: string) =>
  `${RETENTION_TRUNCATION_MARKER_PREFIX} cap=${cap} actual=${actualBytes} command=${command}]`

const retentionIncompleteMarker = (writtenBytes: number, observedBytes: number) =>
  `${RETENTION_INCOMPLETE_MARKER_PREFIX} retention write failed after ${writtenBytes} of ${observedBytes} observed bytes]`

export interface BoundInput {
  readonly sessionID: SessionSchema.ID
  readonly toolCallID: string
  readonly output: ToolOutput
}

export interface BoundResult {
  readonly output: ToolOutput
  readonly outputPaths: ReadonlyArray<string>
  readonly outputRefs?: ReadonlyArray<ManagedOutput.ID>
}

export interface ReadManagedInput {
  readonly path: string
  readonly createdAt: unknown
}

export type ReadManagedResult =
  | { readonly _tag: "Read"; readonly bytes: Uint8Array }
  | { readonly _tag: "Expired" }

export type SinkSettlement =
  /** The artifact holds the complete observed stream (capped, with a truncation marker) and is
   *  registered for the next bound() on this toolCallID — the settlement will carry its out_ ref. */
  | { readonly _tag: "Retained" }
  /** The sink never observed the full stream, so no artifact is referenced; the file is removed.
   *  Not a failure: retention simply did not engage (a process layer without stream tapping). */
  | { readonly _tag: "Incomplete" }
  /** A retention write failed mid-stream or at settle; the partial artifact is marked incomplete
   *  and the caller must report an explicitly lossy result without an out_ ref (CONTEXT.md:204). */
  | { readonly _tag: "Lossy"; readonly reason: string }

/** Managed full-output retention sink for one tool execution (PM-4). Chunks arrive as raw bytes
 *  while the command runs; appends are synchronous so failures surface at the failing chunk and
 *  the artifact never lags the stream. */
export interface Sink {
  /** Never throws. A failed append poisons the sink (lossy) instead of the command. */
  readonly write: (chunk: Uint8Array) => void
  readonly settle: (input: {
    /** Bytes the caller captured through its own bounded path; the artifact is referenced only
     *  when the sink observed at least this much (or the command timed out). */
    readonly capturedBytes: number
    readonly timedOut: boolean
  }) => Effect.Effect<SinkSettlement>
}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("ToolOutputStore.StorageError", {
  operation: Schema.Literals(["encode", "write"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Failed to ${this.operation} tool output${detail ? `: ${detail}` : ""}`
  }
}

export type Error = StorageError

export interface Interface {
  readonly limits: () => Effect.Effect<{ readonly maxLines: number; readonly maxBytes: number }>
  readonly bound: (input: BoundInput) => Effect.Effect<BoundResult, Error>
  readonly readManaged: (input: ReadManagedInput) => Effect.Effect<ReadManagedResult>
  readonly cleanup: () => Effect.Effect<void>
  readonly openSink: (input: { readonly toolCallID: string; readonly command: string }) => Effect.Effect<Sink, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolOutputStore") {}

const takePrefix = (input: string, maximumBytes: number) => {
  let bytes = 0
  let content = ""
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content += char
    bytes += size
  }
  return content
}

const takeSuffix = (input: string, maximumBytes: number) => {
  let bytes = 0
  const content: string[] = []
  for (const char of Array.from(input).toReversed()) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content.unshift(char)
    bytes += size
  }
  return content.join("")
}

const preview = (text: string, maxLines: number, maxBytes: number) => {
  const lines = text.split("\n")
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  const sampled =
    lines.length <= maxLines
      ? text
      : [
          lines.slice(0, headLines).join("\n"),
          ...(tailLines > 0 ? [lines.slice(lines.length - tailLines).join("\n")] : []),
        ].join("\n")
  if (Buffer.byteLength(sampled, "utf-8") <= maxBytes) {
    return lines.length <= maxLines
      ? { head: sampled, tail: "" }
      : {
          head: lines.slice(0, headLines).join("\n"),
          tail: tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : "",
        }
  }
  const headBytes = Math.ceil(maxBytes / 2)
  const tailBytes = Math.floor(maxBytes / 2)
  return { head: takePrefix(sampled, headBytes), tail: takeSuffix(sampled, tailBytes) }
}

const boundedPreview = (text: string, marker: string, maxLines: number, maxBytes: number) => {
  const markerOnly = takePrefix(marker, maxBytes).split("\n").slice(0, maxLines).join("\n")
  const markerBytes = Buffer.byteLength(marker, "utf-8")
  if (maxLines <= 4 || maxBytes <= markerBytes + 4) return markerOnly
  const bounded = preview(text, maxLines - 4, maxBytes - markerBytes - 4)
  return bounded.tail ? `${bounded.head}\n\n${marker}\n\n${bounded.tail}` : `${bounded.head}\n\n${marker}`
}

const lineCount = (text: string) => {
  let count = 1
  for (const char of text) if (char === "\n") count++
  return count
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const config = yield* Effect.serviceOption(Config.Service)
    const directory = path.join(global.data, MANAGED_DIRECTORY)
    const limits = Effect.fn("ToolOutputStore.limits")(function* () {
      if (Option.isNone(config)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const entries = yield* config.value.entries().pipe(Effect.catch(() => Effect.succeed([] as Config.Entry[])))
      const configured = Object.assign(
        {},
        ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info.tool_output ?? {}] : [])),
      )
      return { maxLines: configured.max_lines ?? MAX_LINES, maxBytes: configured.max_bytes ?? MAX_BYTES }
    })

    const write = Effect.fn("ToolOutputStore.write")(function* (content: string) {
      const file = path.join(directory, `tool_${Identifier.ascending()}`)
      yield* fs.ensureDir(directory).pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      yield* fs
        .writeFileString(file, content, { flag: "wx" })
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      return file
    })

    // Full-retention artifacts streamed during tool execution, keyed by the settling tool call.
    // Consumed by bound(); entries only exist between sink settle and the settlement's bound call.
    const artifacts = new Map<string, { readonly path: string; readonly ref: ManagedOutput.ID }>()
    const remember = (toolCallID: string, artifact: { readonly path: string; readonly ref: ManagedOutput.ID }) => {
      artifacts.set(toolCallID, artifact)
      for (const key of artifacts.keys()) {
        if (artifacts.size <= MAX_REMEMBERED_ARTIFACTS) break
        artifacts.delete(key)
      }
    }

    const bestEffortAppend = (file: string, text: string) => {
      try {
        appendFileSync(file, `\n${text}\n`)
      } catch {
        // The artifact is already on a failed path; the .incomplete rename below is the
        // authoritative marking when the text marker cannot be written.
      }
    }

    const openSink = Effect.fn("ToolOutputStore.openSink")(function* (input: {
      readonly toolCallID: string
      readonly command: string
    }) {
      const { toolCallID, command } = input
      const file = path.join(directory, `tool_${Identifier.ascending()}`)
      yield* fs.ensureDir(directory).pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      yield* Effect.try({
        try: () => writeFileSync(file, "", { flag: "wx" }),
        catch: (cause) => new StorageError({ operation: "write", cause }),
      })
      const cap = fullRetentionMaxBytes()
      let observed = 0
      let written = 0
      let failure: unknown
      let settled = false
      const sink: Sink = {
        write: (chunk) => {
          if (settled || failure !== undefined || chunk.length === 0) return
          observed += chunk.length
          if (written >= cap) return
          const slice = cap - written >= chunk.length ? chunk : chunk.subarray(0, cap - written)
          try {
            appendFileSync(file, slice)
            written += slice.length
          } catch (cause) {
            failure = cause
          }
        },
        settle: Effect.fn("ToolOutputStore.sink.settle")(function* (input: {
          readonly capturedBytes: number
          readonly timedOut: boolean
        }) {
          settled = true
          const markIncomplete = () => {
            bestEffortAppend(file, retentionIncompleteMarker(written, observed))
            // The rename keeps the partial bytes inspectable while making the artifact read as
            // incomplete even when the text marker could not be written; the tool_ prefix keeps
            // it inside the retention sweep.
            try {
              renameSync(file, `${file}${INCOMPLETE_SUFFIX}`)
            } catch {}
          }
          if (failure !== undefined) {
            markIncomplete()
            return { _tag: "Lossy" as const, reason: `retention write failed after ${written} of ${observed} bytes` }
          }
          if (!input.timedOut && observed < input.capturedBytes) {
            rmSync(file, { force: true })
            return { _tag: "Incomplete" as const }
          }
          if (observed > written) {
            try {
              appendFileSync(file, `\n${retentionTruncationMarker(cap, observed, command)}\n`)
            } catch (cause) {
              failure = cause
              markIncomplete()
              return {
                _tag: "Lossy" as const,
                reason: `retention marker write failed after ${written} of ${observed} bytes`,
              }
            }
          }
          remember(toolCallID, { path: file, ref: ManagedOutput.ID.create() })
          return { _tag: "Retained" as const }
        }),
      }
      return sink
    })

    const readManaged = Effect.fn("ToolOutputStore.readManaged")(function* (input: ReadManagedInput) {
      const resolved = path.resolve(input.path)
      if (!resolved.startsWith(path.resolve(directory) + path.sep)) return { _tag: "Expired" as const }
      const timestamp = typeof input.createdAt === "string" ? Date.parse(input.createdAt) : Number(input.createdAt)
      if (!Number.isFinite(timestamp) || timestamp < Date.now() - Duration.toMillis(RETENTION)) {
        return { _tag: "Expired" as const }
      }
      const file = Bun.file(resolved)
      if (!(yield* Effect.promise(() => file.exists()))) return { _tag: "Expired" as const }
      return { _tag: "Read" as const, bytes: new Uint8Array(yield* Effect.promise(() => file.arrayBuffer())) }
    })

    const bound = Effect.fn("ToolOutputStore.bound")(function* (input: BoundInput) {
      // A full-retention artifact streamed during this tool call's execution survives generic
      // bounding: it is the complete record, so no second fallback file is written and the
      // preview marker names the streamed artifact.
      const streamed = artifacts.get(input.toolCallID)
      artifacts.delete(input.toolCallID)
      const outputLimits = yield* limits()
      const media = input.output.content.filter((item) => item.type === "file")
      const text = input.output.content.filter((item) => item.type === "text")
      const contextual =
        input.output.content.length === 0
          ? yield* Effect.try({
              try: () => JSON.stringify(input.output.structured, null, 2) ?? String(input.output.structured),
              catch: (cause) => new StorageError({ operation: "encode", cause }),
            })
          : text.map((item) => item.text).join("")
      if (
        lineCount(contextual) <= outputLimits.maxLines &&
        Buffer.byteLength(contextual, "utf-8") <= outputLimits.maxBytes
      ) {
        if (!streamed) return { output: input.output, outputPaths: [] }
        return {
          output: input.output,
          outputPaths: [streamed.path],
          outputRefs: [streamed.ref],
        }
      }

      const outputPath = streamed?.path ?? (yield* write(contextual))
      const marker = `... output truncated; full content saved to ${outputPath} ...`

      return {
        output: {
          structured: input.output.structured,
          content: [
            {
              type: "text" as const,
              text: boundedPreview(contextual, marker, outputLimits.maxLines, outputLimits.maxBytes),
            },
            ...media,
          ],
        },
        outputPaths: [outputPath],
        outputRefs: [streamed?.ref ?? ManagedOutput.ID.create()],
      }
    })

    const cleanup = Effect.fn("ToolOutputStore.cleanup")(function* () {
      const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([])))
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      for (const entry of entries) {
        if (!entry.startsWith("tool_")) continue
        const file = path.join(directory, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.void))
        const modified = info?.mtime.pipe(
          Option.map((date) => date.getTime()),
          Option.getOrElse(() => 0),
        )
        if (modified !== undefined && modified < cutoff) yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    return Service.of({ limits, bound, readManaged, cleanup, openSink })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node, Config.node] })

export const nodeWithoutConfig = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })

/** Runs retention scanning once globally rather than once per active Location. */
export const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Service
    yield* store.cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: Layer.merge(layer, cleanupLayer.pipe(Layer.provide(layer))),
  deps: [FSUtil.node, Global.node],
})
