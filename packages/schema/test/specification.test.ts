import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import vectors from "./fixtures/abc-v1-vectors.json"
import {
  APPROVAL_PAYLOAD_TYPE,
  ErrorRegistry,
  SpecificationABCError,
  assertAbcChain,
  canonicalPayloadBytes,
  errorRegistry,
  pae,
  parseCanonicalPayload,
  parseStrictJson,
  payloadDigest,
  signApprovalPayload,
  validateApprovalEnvelope,
  validateGeneratedArtifactManifest,
  validateSpecPacket,
  verifyApprovalEnvelope,
} from "../src/specification"

const fixtureSha256 = "9efa0bafda26e1057e20b9b2f4875d731c4db40674c7e04301daa45144098599"
const fixtureBytes = await Bun.file(new URL("./fixtures/abc-v1-vectors.json", import.meta.url)).arrayBuffer()
const clone = <T>(value: T): T => structuredClone(value)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected object")
  return value
}

function setPath(value: Record<string, unknown>, path: string[], replacement: unknown) {
  let target: Record<string, unknown> = value
  for (const segment of path.slice(0, -1)) target = record(target[segment])
  target[path.at(-1)!] = replacement
}

function envelope() {
  return {
    version: "approval-envelope-v1",
    payload_type: APPROVAL_PAYLOAD_TYPE,
    payload: clone(vectors.triple.c_payload),
    key_id: vectors.triple.key_id,
    signature: vectors.triple.signature,
  }
}

function expectCode(action: () => unknown, code: string) {
  expect(action).toThrow(SpecificationABCError)
  try {
    action()
  } catch (error) {
    if (!(error instanceof SpecificationABCError)) throw error
    expect(error.code).toBe(code)
  }
}

describe("frozen A/B/C v1 contracts", () => {
  test("pins the byte-identical kernel fixture", () => {
    expect(createHash("sha256").update(Buffer.from(fixtureBytes)).digest("hex")).toBe(fixtureSha256)
  })

  test("canonical vectors have Python-identical bytes and digests", () => {
    for (const vector of vectors.canonical) {
      const value = parseStrictJson(new TextEncoder().encode(vector.raw))
      expect(new TextDecoder().decode(canonicalPayloadBytes(value))).toBe(vector.canonical)
      expect(payloadDigest(value)).toBe(vector.digest)
    }
    for (const vector of vectors.normalization) {
      expect(payloadDigest(vector.nfc)).toBe(vector.nfc_digest)
      expect(payloadDigest(vector.nfd)).toBe(vector.nfd_digest)
      expect(payloadDigest(vector.nfc)).not.toBe(payloadDigest(vector.nfd))
    }
  })

  test("all strict-parser negative vectors select their registry error", () => {
    for (const vector of vectors.negative) {
      const raw =
        vector.input_type === "text"
          ? vector.raw
          : vector.raw_base64
            ? Buffer.from(vector.raw_base64, "base64")
            : Buffer.from(vector.raw!)
      expectCode(
        () => (vector.entry_point === "parse_canonical_payload" ? parseCanonicalPayload(raw) : parseStrictJson(raw)),
        vector.error,
      )
    }
  })

  test("all payload, approval, and signing negatives select their registry error", () => {
    for (const vector of vectors.payload_negative) {
      const value = record(clone(record(vectors.triple)[vector.source]))
      setPath(value, vector.path, vector.value)
      expectCode(
        () =>
          vector.entry_point === "spec_packet" ? validateSpecPacket(value) : validateGeneratedArtifactManifest(value),
        vector.error,
      )
    }
    for (const vector of vectors.approval_negative) {
      const value = envelope()
      setPath(value, vector.path, vector.value)
      expectCode(() => validateApprovalEnvelope(value), vector.error)
    }
    for (const vector of vectors.signing_negative) {
      expectCode(() => signApprovalPayload(vectors.triple.c_payload, vector.private_key), vector.error)
    }
  })

  test("recomputes A, B, and authoritative C payload identities", () => {
    expect(payloadDigest(vectors.triple.a)).toBe(vectors.triple.a_digest)
    expect(payloadDigest(vectors.triple.b)).toBe(vectors.triple.b_digest)
    expect(payloadDigest(vectors.triple.c_payload)).toBe(vectors.triple.c_digest)
    expect(vectors.contract.c_authoritative_identity).toContain("approval-envelope payload digest")
    for (const vector of vectors.contract.pae) {
      const preimage = pae(vector.payload_type, Buffer.from(vector.body_hex, "hex"))
      expect(preimage.toString("hex")).toBe(vector.preimage_hex)
      expect(`sha256:${createHash("sha256").update(preimage).digest("hex")}`).toBe(vector.digest)
    }
  })

  test("validates the frozen detached signature and signs it byte-for-byte", () => {
    const value = envelope()
    expect(verifyApprovalEnvelope(value)).toBe(true)
    expect(signApprovalPayload(value.payload, "ed25519:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")).toBe(
      vectors.triple.signature,
    )
    value.signature = `${value.signature.slice(0, -3)}A==`
    expectCode(() => validateApprovalEnvelope(value), errorRegistry.errors.signature.code)
  })

  test("rejects tampering, domain substitution, and nonce reuse with exact codes", () => {
    const tampered = envelope()
    tampered.signature = `${tampered.signature.slice(0, -3)}A==`
    expectCode(() => validateApprovalEnvelope(tampered), errorRegistry.errors.signature.code)
    expectCode(
      () => validateApprovalEnvelope(envelope(), [vectors.triple.c_payload.nonce]),
      errorRegistry.errors.nonce_reuse.code,
    )
    const swapped = envelope()
    swapped.payload_type = "application/vnd.ranex.spec-packet.v1+json"
    expectCode(() => validateApprovalEnvelope(swapped), errorRegistry.errors.payload_type.code)
  })

  test("enforces all A/B/C bindings and context equality", () => {
    assertAbcChain(vectors.triple.a, vectors.triple.b, envelope())
    for (const vector of vectors.chain_negative) {
      const b = clone(vectors.triple.b) as Record<string, unknown>
      const c = envelope()
      setPath(vector.target === "b" ? b : c, vector.path, vector.value)
      expectCode(() => assertAbcChain(vectors.triple.a, b, c), vector.error)
    }
    for (const vector of vectors.chain_context_negative) {
      const c = envelope()
      setPath(c, vector.path, vector.value)
      c.signature = signApprovalPayload(c.payload, "ed25519:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
      expectCode(() => assertAbcChain(vectors.triple.a, vectors.triple.b, c), vector.error)
    }
  })

  test("registry ordering is data-driven and load-bearing", () => {
    const raw = {
      version: "ranex-specification-error-registry-v1",
      precedence: [...errorRegistry.checkOrder],
      check_order: [...errorRegistry.checkOrder],
      errors: structuredClone(errorRegistry.errors),
    }
    for (let index = 0; index < raw.check_order.length - 1; index++) {
      const first = raw.check_order[index]
      const second = raw.check_order[index + 1]
      const regular = new ErrorRegistry(raw)
      const candidates = new Map([
        [first, "first"],
        [second, "second"],
      ])
      expectCode(() => regular.refuseFirst(candidates), raw.errors[first].code)
      const permuted = structuredClone(raw)
      permuted.precedence.splice(index, 2, second, first)
      permuted.check_order.splice(index, 2, second, first)
      expectCode(() => new ErrorRegistry(permuted).refuseFirst(candidates), raw.errors[second].code)
    }
  })
})
