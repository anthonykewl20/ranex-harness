export * as EventStreamGeneration from "./event-stream-generation"

import { EventV2 } from "@ranex/core/event"
import { Effect } from "effect"

type Generation = {
  readonly close: Effect.Effect<void>
}

type State = {
  readonly generations: Map<string, Generation>
  supersededStreams: number
}

export type Diagnostics = {
  readonly supersededStreams: number
  readonly activeGenerations: number
}

const states = new WeakMap<EventV2.Interface, State>()

export const register = (events: EventV2.Interface, clientID: string, generation: Generation) =>
  Effect.uninterruptible(
    Effect.sync(() => {
      const state = getState(events)
      const previous = state.generations.get(clientID)
      state.generations.set(clientID, generation)
      if (previous) state.supersededStreams++
      return previous
    }).pipe(Effect.flatMap((previous) => previous?.close ?? Effect.void)),
  )

export const deregister = (events: EventV2.Interface, clientID: string, generation: Generation) =>
  Effect.sync(() => {
    const state = getState(events)
    if (state.generations.get(clientID) !== generation) return
    state.generations.delete(clientID)
  })

export const diagnostics = (events: EventV2.Interface): Diagnostics => {
  const state = getState(events)
  return { supersededStreams: state.supersededStreams, activeGenerations: state.generations.size }
}

function getState(events: EventV2.Interface): State {
  const existing = states.get(events)
  if (existing) return existing
  const created = { generations: new Map(), supersededStreams: 0 }
  states.set(events, created)
  return created
}
