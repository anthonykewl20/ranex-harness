export * as ProjectedEvent from "./projected-event"

import { Event } from "@ranex/schema/event"
import { ManagedOutput } from "@ranex/schema/managed-output"
import type { Envelope } from "@ranex/schema/projected-event"
import type { Payload } from "@ranex/schema/event"

export const MAX_FIELD_BYTES = 8 * 1024
export const MAX_EVENT_BYTES = 32 * 1024

const textEncoder = new TextEncoder()
const marker = "[content omitted; fetch the durable payload for the complete value]"
const fileMarker = "[oversized file attachment omitted]"

export type Result = {
  readonly event: Envelope
  readonly droppedBytes: number
  readonly failed?: boolean
  readonly errorName?: string
}

export function project(event: Payload): Result {
  try {
    const state = { truncated: false, droppedBytes: 0 }
    const canonical = isRecord(event.data) ? event.data : { value: event.data }
    const outputRefs = Array.isArray(canonical.outputRefs)
      ? canonical.outputRefs.filter((value): value is ManagedOutput.ID => typeof value === "string" && value.startsWith("out_"))
      : []
    const boundedOutputRefs = outputRefs.reduce(
      (result, outputRef) => {
        const size = bytes(outputRef) + 3
        if (result.refs.length === 128 || result.bytes + size > 16 * 1024) return result
        return { refs: [...result.refs, outputRef], bytes: result.bytes + size }
      },
      { refs: [] as ManagedOutput.ID[], bytes: 0 },
    ).refs
    if (boundedOutputRefs.length !== outputRefs.length) {
      state.truncated = true
      state.droppedBytes += bytes(outputRefs.slice(boundedOutputRefs.length))
    }
    const hasPaths = Array.isArray(canonical.outputPaths) && canonical.outputPaths.length > 0
    const data = Object.fromEntries(Object.entries(canonical).map(([key, value]) => [key, projectValue(value, state, key)]))
    const source = data as Record<string, unknown>
    if ("outputPaths" in source) delete source.outputPaths
    if ("outputRefs" in source) delete source.outputRefs
    if (hasPaths) state.truncated = true
    const projected: Envelope = {
      id: event.id,
      type: event.type,
      ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
      ...(event.durable === undefined ? {} : { durable: event.durable }),
      ...(event.location === undefined ? {} : { location: event.location }),
      data,
      truncated: state.truncated,
      ...(state.truncated && event.durable ? { payloadID: event.id } : {}),
      ...(boundedOutputRefs.length === 0 ? {} : { outputRefs: boundedOutputRefs }),
    }
    if (bytes(projected) <= MAX_EVENT_BYTES) return { event: projected, droppedBytes: state.droppedBytes }
    const fallback: Envelope = {
      id: event.id,
      type: event.type,
      ...(event.durable === undefined ? {} : { durable: event.durable }),
      ...(event.location === undefined ? {} : { location: event.location }),
      data: {},
      truncated: true,
      ...(event.durable ? { payloadID: event.id } : {}),
      ...(boundedOutputRefs.length === 0 ? {} : { outputRefs: boundedOutputRefs }),
    }
    return { event: fallback, droppedBytes: state.droppedBytes + bytes(projected.data) }
  } catch (error) {
    return {
      event: {
        id: event.id,
        type: event.type,
        ...(event.durable === undefined ? {} : { durable: event.durable }),
        ...(event.location === undefined ? {} : { location: event.location }),
        data: {},
        truncated: true,
        ...(event.durable ? { payloadID: event.id } : {}),
      },
      droppedBytes: 0,
      failed: true,
      errorName: error instanceof Error ? error.name : typeof error,
    }
  }
}

function projectValue(value: unknown, state: { truncated: boolean; droppedBytes: number }, key: string | undefined): unknown {
  if (typeof value === "string") return projectText(value, state)
  if (Array.isArray(value)) return projectArray(value, state, key)
  if (!isRecord(value)) return value
  if (bytes(value) > MAX_FIELD_BYTES) {
    state.truncated = true
    state.droppedBytes += bytes(value)
    return {}
  }
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, projectValue(item, state, name)]))
}

function projectArray(value: ReadonlyArray<unknown>, state: { truncated: boolean; droppedBytes: number }, key: string | undefined) {
  if (key === "files") {
    const entries = value.flatMap((item) => {
      if (bytes(item) <= MAX_FIELD_BYTES) return [projectValue(item, state, undefined)]
      state.truncated = true
      state.droppedBytes += bytes(item)
      return []
    })
    if (entries.length === value.length) return entries
    return [...entries, { type: "text", text: fileMarker }]
  }
  if (bytes(value) <= MAX_FIELD_BYTES) return value.map((item) => projectValue(item, state, undefined))
  state.truncated = true
  state.droppedBytes += bytes(value)
  if (key === "content") return [{ type: "text", text: marker }]
  return [marker]
}

function projectText(value: string, state: { truncated: boolean; droppedBytes: number }) {
  const size = bytes(value)
  if (size <= MAX_FIELD_BYTES) return value
  state.truncated = true
  state.droppedBytes += size - MAX_FIELD_BYTES
  const allowance = MAX_FIELD_BYTES - bytes(marker) - 2
  const head = prefix(value, Math.ceil(allowance / 2))
  const tail = suffix(value, Math.floor(allowance / 2))
  return `${head}\n${marker}\n${tail}`
}

function prefix(value: string, maximum: number) {
  let result = ""
  let used = 0
  for (const char of value) {
    const size = bytes(char)
    if (used + size > maximum) return result
    result += char
    used += size
  }
  return result
}

function suffix(value: string, maximum: number) {
  const chars: string[] = []
  let used = 0
  for (const char of Array.from(value).toReversed()) {
    const size = bytes(char)
    if (used + size > maximum) break
    chars.unshift(char)
    used += size
  }
  return chars.join("")
}

function bytes(value: unknown) {
  return textEncoder.encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
