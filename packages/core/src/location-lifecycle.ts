export * as LocationLifecycle from "./location-lifecycle"

import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { Location } from "./location"

export type Kind = "fiber" | "event_consumer" | "listener" | "subscription"
export type Owner =
  | "vcs-warmup"
  | "watcher"
  | "plugin-boot"
  | "models-dev-refresh"
  | "opencode-refresh"
  | "integration-scrub"
  | "integration-attempt"
  | "reference-refresh"
  | "project-copy-refresh"
  | "filesystem-search"

type State = "active" | "closing" | "closed"
type Entry = { readonly kind: Kind; readonly owner: Owner }
type Census = { readonly state: State; readonly entries: ReadonlyMap<string, Entry> }

export interface Inspection {
  readonly generationID: string
  readonly state: State
  readonly counts: Readonly<Record<Kind, number>>
  readonly owners: readonly Owner[]
}

export interface ClosedInspection extends Inspection {
  readonly locationKey: string
}

export class RegistrationClosedError extends Schema.TaggedErrorClass<RegistrationClosedError>()(
  "LocationLifecycle.RegistrationClosed",
  { generationID: Schema.String },
) {
  override get message() {
    return `Location generation ${this.generationID} is no longer active`
  }
}

export class IncompleteTeardown extends Error {
  readonly generationID: string
  readonly countsByKind: Readonly<Record<Kind, number>>
  readonly owners: readonly Owner[]

  constructor(input: { readonly generationID: string; readonly countsByKind: Readonly<Record<Kind, number>>; readonly owners: readonly Owner[] }) {
    super(`Incomplete location teardown ${JSON.stringify(input)}`)
    this.name = "LocationLifecycle.IncompleteTeardown"
    this.generationID = input.generationID
    this.countsByKind = input.countsByKind
    this.owners = input.owners
  }
}

export interface Interface {
  readonly generationID: string
  readonly register: (kind: Kind, owner: Owner) => Effect.Effect<Effect.Effect<void>, RegistrationClosedError>
  readonly inspect: () => Effect.Effect<Inspection>
  readonly close: () => Effect.Effect<void>
}

export type CapturedRegistration =
  | { readonly _tag: "tracked"; readonly unregister: Effect.Effect<void> }
  | { readonly _tag: "untracked" }
  | { readonly _tag: "closed" }

export class Service extends Context.Service<Service, Interface>()("@opencode/LocationLifecycle") {}

export const make = (input: {
  readonly location: Location.Ref
  readonly locationKey: string
  readonly onClosed?: (inspection: ClosedInspection) => void
}) =>
  Effect.gen(function* () {
    const generationID = crypto.randomUUID()
    const census = yield* Ref.make<Census>({ state: "active", entries: new Map() })
    const inspect = () =>
      Ref.get(census).pipe(
        Effect.map((current) => inspection(generationID, current)),
      )
    const register: Interface["register"] = (kind, owner) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID()
        const accepted = yield* Ref.modify(census, (current) => {
          if (current.state !== "active") return [false, current] as const
          const entries = new Map(current.entries)
          entries.set(id, { kind, owner })
          return [true, { ...current, entries }] as const
        })
        if (!accepted) return yield* new RegistrationClosedError({ generationID })
        return Ref.update(census, (current) => {
          if (!current.entries.has(id)) return current
          const entries = new Map(current.entries)
          entries.delete(id)
          return { ...current, entries }
        })
      })
    const close = () =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.modify(census, (state) => {
            if (state.state !== "active") return [undefined, state] as const
            return [state, { ...state, state: "closing" }] as const
          })
          if (!current) return
          const result = inspection(generationID, current)
          yield* Ref.update(census, (state) => ({ ...state, state: "closed" as const }))
          if (current.entries.size > 0)
            return yield* Effect.die(
              new IncompleteTeardown({
                generationID,
                countsByKind: result.counts,
                owners: result.owners,
              }),
            )
          const closed: ClosedInspection = {
            ...inspection(generationID, { ...current, state: "closed" }),
            locationKey: input.locationKey,
          }
          yield* Effect.logDebug("closed location services", {
            generationID,
            locationKey: input.locationKey,
            workspaceIDPresent: input.location.workspaceID !== undefined,
            state: closed.state,
            counts: closed.counts,
          })
          if (input.onClosed) yield* Effect.sync(() => input.onClosed?.(closed)).pipe(Effect.ignore)
        }),
      )
    return Service.of({ generationID, register, inspect, close })
  })

export const layer = (input: {
  readonly location: Location.Ref
  readonly locationKey: string
  readonly onClosed?: (inspection: ClosedInspection) => void
}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const lifecycle = yield* make(input)
      yield* Effect.addFinalizer(() => lifecycle.close())
      return lifecycle
    }),
  )

/** Registers a resource in the current scope. Add it immediately before the scoped resource is acquired. */
export const track = (kind: Kind, owner: Owner) =>
  registerOptional(kind, owner).pipe(
    Effect.flatMap((unregister) => (unregister ? Effect.addFinalizer(() => unregister) : Effect.void)),
  )

export const registerOptional = (kind: Kind, owner: Owner) =>
  Effect.serviceOption(Service).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<Effect.Effect<void> | undefined>(undefined),
        onSome: (lifecycle) =>
          lifecycle.register(kind, owner).pipe(
            Effect.map((unregister) => unregister as Effect.Effect<void> | undefined),
          ),
      }),
    ),
    Effect.orDie,
  )

export const capture = () => Effect.serviceOption(Service)

export const registerCaptured = (
  lifecycle: Option.Option<Interface>,
  kind: Kind,
  owner: Owner,
): Effect.Effect<CapturedRegistration> => {
  if (Option.isNone(lifecycle)) return Effect.succeed<CapturedRegistration>({ _tag: "untracked" })
  return lifecycle.value.register(kind, owner).pipe(
    Effect.map((unregister): CapturedRegistration => ({ _tag: "tracked", unregister })),
    Effect.catchTag("LocationLifecycle.RegistrationClosed", () => Effect.succeed<CapturedRegistration>({ _tag: "closed" })),
  )
}

function inspection(generationID: string, current: Census): Inspection {
  const counts: Record<Kind, number> = { fiber: 0, event_consumer: 0, listener: 0, subscription: 0 }
  for (const entry of current.entries.values()) counts[entry.kind] += 1
  return {
    generationID,
    state: current.state,
    counts,
    owners: Array.from(new Set(Array.from(current.entries.values(), (entry) => entry.owner))).toSorted(),
  }
}
