import { describe, expect, test } from "bun:test"
import { admitSpecification } from "../../src/control-plane/specification-admission"
import type { SpecificationAdmissionEnvelope, SpecificationCapabilities } from "@opencode-ai/core/tool/specification-admission"

type FrozenRequest = {
  version: string
  family: string
  caller_principal_id: string
  caller_key: string
  active_harness_profile_digest: string
  capabilities: SpecificationCapabilities
}
type FrozenMutation = {
  kind: string
  observed_event_head?: string
  caller_key?: string
  family?: string
  capabilities?: SpecificationCapabilities
  child_capabilities?: SpecificationCapabilities
  evaluations?: string[]
  observed_position?: number
}
type FrozenRow = { name: string; request: FrozenRequest; mutation: FrozenMutation; output: SpecificationAdmissionEnvelope }
type FrozenVectors = {
  grant_id: string
  c_digest: string
  caller: { caller_principal_id: string; caller_key: string }
  harness_profile_digest: string
  capability_request: SpecificationCapabilities
  c_payload: { time_window: { not_before: number; not_after: number } }
  observed: { event_head: string; position: number }
  rows: FrozenRow[]
}

const vectorPath = process.env.RANEX_FROZEN_VECTOR_FILE
if (!vectorPath) throw new Error("RANEX_FROZEN_VECTOR_FILE is required for specification-admission tests")
const rawVectors: unknown = await Bun.file(vectorPath).json()
if (!isFrozenVectors(rawVectors)) throw new Error("Invalid frozen specification admission vectors")
const vectors = rawVectors

function isFrozenVectors(value: unknown): value is FrozenVectors {
  return typeof value === "object" && value !== null && "rows" in value && Array.isArray(value.rows)
}

function input(row: FrozenRow) {
  const grant = {
    grant_id: vectors.grant_id,
    c_digest: vectors.c_digest,
    caller_principal_id: vectors.caller.caller_principal_id,
    caller_key: vectors.caller.caller_key,
    active_harness_profile_digest: vectors.harness_profile_digest,
    capabilities: vectors.capability_request,
    not_before: vectors.c_payload.time_window.not_before,
    not_after: vectors.c_payload.time_window.not_after,
    revoked: row.mutation.kind === "grant_revoked",
    observed_event_head: vectors.observed.event_head,
    observed_position: vectors.observed.position,
  }
  const request = structuredClone(row.request)
  if (row.mutation.capabilities) request.capabilities = row.mutation.capabilities
  if (row.mutation.kind === "unknown_family") request.family = row.mutation.family!
  return {
    request,
    grant,
    observed_event_head: row.mutation.kind === "missing_context" ? undefined : row.mutation.observed_event_head ?? vectors.observed.event_head,
    observed_position: row.mutation.kind === "missing_context" ? undefined : vectors.observed.position,
    observed_caller_key: row.mutation.kind === "identity_mismatch" ? row.mutation.caller_key : undefined,
    now: row.mutation.kind === "window_expired" ? row.mutation.observed_position : undefined,
    child_capabilities: row.mutation.child_capabilities,
  }
}

describe("control-plane specification admission", () => {
  test("translates and evaluates every frozen vector case", () => {
    for (const row of vectors.rows) {
      if (row.mutation.kind === "cached_sequence") {
        const first = input({ ...row, mutation: { kind: "none" } })
        admitSpecification(first)
        const second = input({ ...row, mutation: row.mutation.evaluations?.[1] === "revoked" ? { kind: "grant_revoked" } : { kind: "window_expired", observed_position: vectors.c_payload.time_window.not_after + 1 } })
        expect(admitSpecification(second), row.name).toEqual(row.output)
        continue
      }
      expect(admitSpecification(input(row)), row.name).toEqual(row.output)
    }
  })
})
