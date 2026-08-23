import { describe, expect, test } from "bun:test"
import { admitSpecification, type SpecificationAdmissionEnvelope, type SpecificationCapabilities } from "../../src/tool/specification-admission"

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

function baseFacts() {
  return {
    grant_id: vectors.grant_id,
    c_digest: vectors.c_digest,
    caller_principal_id: vectors.caller.caller_principal_id,
    caller_key: vectors.caller.caller_key,
    active_harness_profile_digest: vectors.harness_profile_digest,
    capabilities: vectors.capability_request,
    not_before: vectors.c_payload.time_window.not_before,
    not_after: vectors.c_payload.time_window.not_after,
    revoked: false,
    observed_event_head: vectors.observed.event_head,
    observed_position: vectors.observed.position,
  }
}

function caseInput(row: FrozenRow) {
  const request = structuredClone(row.request)
  const grant = baseFacts()
  const facts = {
    grant,
    observed_event_head: vectors.observed.event_head,
    observed_position: vectors.observed.position,
    observed_caller_key: undefined as string | undefined,
    now: undefined as number | undefined,
    child_capabilities: undefined as SpecificationCapabilities | undefined,
  }
  const mutation = row.mutation
  if (mutation.kind === "missing_context") {
    return { request, facts: { grant } }
  }
  if (mutation.kind === "invalid_event_chain") facts.observed_event_head = mutation.observed_event_head!
  if (mutation.kind === "identity_mismatch") facts.observed_caller_key = mutation.caller_key
  if (mutation.kind === "grant_revoked") grant.revoked = true
  if (mutation.kind === "window_expired") facts.now = mutation.observed_position!
  if (mutation.capabilities) request.capabilities = mutation.capabilities
  if (mutation.kind === "unknown_family") request.family = mutation.family!
  if (mutation.kind === "child_intersection" || mutation.kind === "child_widen") {
    facts.child_capabilities = mutation.child_capabilities
  }
  return { request, facts }
}

describe("core specification admission", () => {
  test("evaluates every frozen vector case", () => {
    for (const row of vectors.rows) {
      if (row.mutation.kind === "cached_sequence") {
        const first = caseInput({ ...row, mutation: { kind: "none" } })
        admitSpecification(first.request, first.facts)
        const secondMutation = row.mutation.evaluations?.[1] === "revoked" ? { kind: "grant_revoked" } : { kind: "window_expired", observed_position: vectors.c_payload.time_window.not_after + 1 }
        const second = caseInput({ ...row, mutation: secondMutation })
        expect(admitSpecification(second.request, second.facts), row.name).toEqual(row.output)
        continue
      }
      const input = caseInput(row)
      expect(admitSpecification(input.request, input.facts), row.name).toEqual(row.output)
    }
  })

  test("returns a fresh immutable envelope and is trace-neutral", () => {
    const row = vectors.rows.find((item) => item.name === "allow")
    if (!row) throw new Error("allow vector is required")
    const off = caseInput(row)
    const first = admitSpecification(off.request, off.facts)
    const traceFacts = { ...off.facts, trace: "failure" }
    const second = admitSpecification(off.request, traceFacts)
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    expect(Object.isFrozen(second)).toBe(true)
    expect(Object.isFrozen(second.record)).toBe(true)
    expect(() => ((second.record as { decision: string }).decision = "deny")).toThrow()
  })

  test("denies closed-schema violations and malformed child capabilities", () => {
    const row = vectors.rows.find((item) => item.name === "allow")
    if (!row) throw new Error("allow vector is required")
    const input = caseInput(row)
    const extraRequest = { ...input.request, extra: true }
    expect(admitSpecification(extraRequest, input.facts).record.code).toBe("E-APPROVAL-GRANT-UNISSUED")
    const extraCapabilities = { ...input.request.capabilities, raw_syscall: true }
    expect(admitSpecification({ ...input.request, capabilities: extraCapabilities }, input.facts).record.code).toBe("E-APPROVAL-GRANT-UNISSUED")
    for (const child_capabilities of [null, 42, { ...input.request.capabilities, argv: undefined }]) {
      const malformedFacts = { ...input.facts }
      Reflect.set(malformedFacts, "child_capabilities", child_capabilities)
      expect(admitSpecification(input.request, malformedFacts).record.code).toBe("E-APPROVAL-GRANT-UNISSUED")
    }
  })
})
