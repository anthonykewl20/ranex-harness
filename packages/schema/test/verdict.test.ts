import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { KNOWN_CAUSES, ClaimCause, Record as VerdictRecord, isKnownCause } from "../src/verdict"

const decode = Schema.decodeUnknownSync(VerdictRecord)

/** A complete FAIL, matching the shape `Evaluation.as_record()` produces. */
function record(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    verdict: "FAIL",
    gate_id: "landing",
    subject_digest: "sha256:15d70fd2b7bf9f196908c93c3ead6c039910a59c9c3636f6b2a82af71c58a81b",
    subject_lane: "PRE_READINESS_PRODUCT_SLICE",
    catalog_digest: "sha256:4c8e10bb",
    approver_id: "owner",
    failing_rule: "TESTS_EXECUTED",
    missing_claims: ["tests-executed", "diff-reviewed"],
    considered: ["tests-frozen", "tests-executed"],
    causes: [
      { claim_id: "tests-executed", cause: "refused" },
      { claim_id: "diff-reviewed", cause: "absent" },
    ],
    rejections: [
      { index: 0, reason: "malformed-record", detail: "missing field(s): suite_results", claim_id: "tests-executed" },
    ],
    reason: "no evidence for required claim: diff-reviewed",
    record_digest: "sha256:a3f9c2e1",
    ...overrides,
  }
}

describe("the verdict record", () => {
  test("decodes a complete evaluation", () => {
    expect(decode(record()).verdict).toBe("FAIL")
  })

  test("every field is required — there is no partial verdict", () => {
    // A record missing its subject digest describes no tree, and one missing
    // its outcome is not a verdict. Absence blocks here too: decode fails
    // rather than filling a default in.
    for (const field of ["verdict", "gate_id", "subject_digest", "record_digest", "causes"]) {
      const partial = record()
      delete (partial as Record<string, unknown>)[field]
      expect(() => decode(partial)).toThrow()
    }
  })

  test("the outcome set is closed", () => {
    expect(() => decode(record({ verdict: "PASS" }))).not.toThrow()
    // No third state, and no rank. Absence is already FAIL.
    expect(() => decode(record({ verdict: "ABSENT" }))).toThrow()
    expect(() => decode(record({ verdict: "WARN" }))).toThrow()
  })

  test("nullable fields accept null but not absence", () => {
    expect(decode(record({ catalog_digest: null, failing_rule: null, reason: null })).reason).toBeNull()
    const missing = record()
    delete (missing as Record<string, unknown>).catalog_digest
    expect(() => decode(missing)).toThrow()
  })
})

describe("causes", () => {
  test("all seven kinds decode", () => {
    expect(KNOWN_CAUSES).toHaveLength(7)
    for (const cause of KNOWN_CAUSES) {
      expect(() => decode(record({ causes: [{ claim_id: "c", cause }] }))).not.toThrow()
    }
  })

  test("an unknown cause is carried, not rejected", () => {
    // If the kernel gains an eighth cause, a strict union would reject the whole
    // record and the operator would see no verdict at all — strictly worse than
    // seeing one cause they cannot name. Renderers show it as unclassified.
    const eighth = decode(record({ causes: [{ claim_id: "c", cause: "revoked" }] }))
    expect(eighth.causes[0].cause).toBe("revoked")
    expect(isKnownCause(eighth.causes[0].cause)).toBe(false)
  })

  test("a null claim_id survives to the screen", () => {
    // An admission rejection can carry no usable claim. Coercing that null to a
    // claim is how a forgery gets filed as honest absence.
    const bare = decode(record({ causes: [{ claim_id: null, cause: "unattributable" }] }))
    expect(bare.causes[0].claim_id).toBeNull()
    const rejected = decode(record({
      rejections: [{ index: 1, reason: "signature", detail: "bad", claim_id: null }],
    }))
    expect(rejected.rejections[0].claim_id).toBeNull()
  })

  test("refused and absent are distinct values, not degrees", () => {
    expect(isKnownCause("refused")).toBe(true)
    expect(isKnownCause("absent")).toBe(true)
    expect(KNOWN_CAUSES.indexOf("absent")).not.toBe(KNOWN_CAUSES.indexOf("refused"))
  })

  test("a cause detail is optional", () => {
    const detailed = Schema.decodeUnknownSync(ClaimCause)({
      claim_id: "tests-executed",
      cause: "failed",
      detail: "2 failed, 410 passed",
    })
    expect(detailed.detail).toBe("2 failed, 410 passed")
  })
})

describe("rejections", () => {
  test("a negative index is refused", () => {
    expect(() =>
      decode(record({ rejections: [{ index: -1, reason: "r", detail: "d", claim_id: null }] })),
    ).toThrow()
  })

  test("rejections may be present on a PASS", () => {
    // A forgery a gate happened to pass without is still a forgery, so the
    // shape must permit reporting it.
    const passed = decode(record({
      verdict: "PASS",
      failing_rule: null,
      missing_claims: [],
      causes: [],
    }))
    expect(passed.rejections).toHaveLength(1)
  })
})
