import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto"
import registryData from "./specification-error-registry-v1.json"

export const SPEC_PACKET_PAYLOAD_TYPE = "application/vnd.ranex.spec-packet.v1+json"
export const MANIFEST_PAYLOAD_TYPE = "application/vnd.ranex.generated-artifact-manifest.v1+json"
export const APPROVAL_PAYLOAD_TYPE = "application/vnd.ranex.approval-envelope.v1+json"

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const digestPattern = /^sha256:[0-9a-f]{64}$/
const keyPattern = /^ed25519:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/
const signaturePattern = /^ed25519:[A-Za-z0-9+/]{85}[AQgw]==$/

type ErrorEntry = { code: string; message: string }
type RegistryData = { version: string; precedence: string[]; check_order: string[]; errors: Record<string, ErrorEntry> }

export class SpecificationABCError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail: string,
  ) {
    super(`${code}: ${detail}`)
  }
}

export class ErrorRegistry {
  readonly errors: Record<string, ErrorEntry>
  readonly checkOrder: readonly string[]

  constructor(raw: RegistryData = registryData as RegistryData) {
    if (
      raw.version !== "ranex-specification-error-registry-v1" ||
      !Array.isArray(raw.precedence) ||
      !Array.isArray(raw.check_order) ||
      Object.keys(raw.errors).length !== raw.precedence.length ||
      raw.precedence.length !== raw.check_order.length ||
      raw.precedence.some((name, index) => name !== raw.check_order[index]) ||
      raw.precedence.some((name) => raw.errors[name] === undefined)
    ) {
      throw new Error("invalid specification error registry")
    }
    this.errors = raw.errors
    this.checkOrder = raw.check_order
  }

  refuse(name: string, detail: string): never {
    const entry = this.errors[name]
    if (!entry) throw new SpecificationABCError("E-ABC-000", `error registry has no entry for ${JSON.stringify(name)}`)
    throw new SpecificationABCError(entry.code, `${entry.message}: ${detail}`)
  }

  refuseFirst(failures: ReadonlyMap<string, string>): never {
    for (const name of this.checkOrder) if (failures.has(name)) this.refuse(name, failures.get(name)!)
    throw new SpecificationABCError("E-ABC-000", "no registered failure candidate")
  }
}

export const errorRegistry = new ErrorRegistry()

class Failures {
  readonly values = new Map<string, string>()
  constructor(private readonly registry: ErrorRegistry) {}
  add(name: string, detail: string) {
    if (!this.values.has(name)) this.values.set(name, detail)
  }
  refuseIfAny() {
    if (this.values.size) this.registry.refuseFirst(this.values)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireObject(value: unknown, fields: readonly string[], registry: ErrorRegistry) {
  if (!isObject(value) || Object.keys(value).length !== fields.length || fields.some((field) => !(field in value))) {
    registry.refuse("shape", "object has missing or extra fields")
  }
  return value
}

function requireString(value: unknown, registry: ErrorRegistry) {
  if (typeof value !== "string" || !value) registry.refuse("shape", "required string is absent or empty")
  return value
}

function requireStrings(value: unknown, registry: ErrorRegistry) {
  if (!isStringArray(value)) registry.refuse("shape", "expected a string array")
  return value
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
}

function requireInteger(value: unknown, registry: ErrorRegistry) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    registry.refuse("shape", "expected a non-negative integer")
  }
  return value
}

function requireDigest(value: unknown, registry: ErrorRegistry) {
  if (typeof value !== "string" || !digestPattern.test(value)) registry.refuse("digest", JSON.stringify(value))
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compareCodePoints(left: string, right: string) {
  const l = Array.from(left)
  const r = Array.from(right)
  for (let index = 0; index < Math.min(l.length, r.length); index++) {
    const difference = l[index].codePointAt(0)! - r[index].codePointAt(0)!
    if (difference) return difference
  }
  return l.length - r.length
}

function quote(text: string) {
  let result = '"'
  for (const character of text) {
    const code = character.codePointAt(0)!
    if (character === '"') result += '\\"'
    else if (character === "\\") result += "\\\\"
    else if (character === "\b") result += "\\b"
    else if (character === "\f") result += "\\f"
    else if (character === "\n") result += "\\n"
    else if (character === "\r") result += "\\r"
    else if (character === "\t") result += "\\t"
    else if (code < 0x20) result += `\\u${code.toString(16).padStart(4, "0")}`
    else if (code === 0x2028 || code === 0x2029) result += `\\u${code.toString(16).padStart(4, "0")}`
    else if (code >= 0xd800 && code <= 0xdfff) throw new Error("surrogate")
    else result += character
  }
  return result + '"'
}

function serialize(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return quote(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("number")
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`
  if (!isPlainObject(value)) throw new Error("shape")
  return `{${Object.keys(value)
    .sort(compareCodePoints)
    .map((key) => `${quote(key)}:${serialize(value[key])}`)
    .join(",")}}`
}

export function canonicalPayloadBytes(value: unknown, registry = errorRegistry): Uint8Array {
  try {
    return encoder.encode(serialize(value))
  } catch (error) {
    if (error instanceof Error && error.message === "surrogate")
      registry.refuse("surrogate", "in-memory string has a surrogate")
    if (error instanceof Error && error.message === "number") registry.refuse("number", "in-memory float is forbidden")
    return registry.refuse("shape", error instanceof Error ? error.message : String(error))
  }
}

export function pae(payloadType: string, body: Uint8Array) {
  if (typeof payloadType !== "string" || !(body instanceof Uint8Array))
    throw new TypeError("payloadType must be string and body must be bytes")
  const type = encoder.encode(payloadType)
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `),
    Buffer.from(type),
    Buffer.from(` ${body.length} `),
    Buffer.from(body),
  ])
}

export function payloadDigest(value: unknown, payloadType?: string, registry = errorRegistry) {
  const inferred = isObject(value)
    ? (
        {
          "spec-packet-v1": SPEC_PACKET_PAYLOAD_TYPE,
          "generated-artifact-manifest-v1": MANIFEST_PAYLOAD_TYPE,
          "approval-payload-v1": APPROVAL_PAYLOAD_TYPE,
          "approval-envelope-v1": APPROVAL_PAYLOAD_TYPE,
        } as Record<string, string>
      )[String(value.version)]
    : undefined
  const body = canonicalPayloadBytes(value, registry)
  const domain = payloadType ?? inferred
  const preimage = domain === undefined ? body : pae(domain, body)
  return `sha256:${createHash("sha256").update(preimage).digest("hex")}`
}

function lexicalFailures(text: string, failures: Failures) {
  let string = false
  let index = 0
  const objectKeys: Set<string>[] = []
  while (index < text.length) {
    const character = text[index]
    if (!string && character === "{") objectKeys.push(new Set())
    if (!string && character === "}") objectKeys.pop()
    if (character !== '"') {
      index++
      continue
    }
    string = true
    const start = index++
    while (index < text.length && text[index] !== '"') {
      if (text[index] !== "\\") {
        index++
        continue
      }
      if (index + 1 >= text.length) {
        failures.add("escape", "unterminated escape")
        break
      }
      const escape = text[index + 1]
      if (escape !== "u") {
        if (!'"\\/bfnrt'.includes(escape)) failures.add("escape", "invalid escape character")
        index += 2
        continue
      }
      const unit = text.slice(index + 2, index + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(unit)) {
        failures.add("escape", "unicode escape must contain exactly four hexadecimal digits")
        index += 6
        continue
      }
      const code = Number.parseInt(unit, 16)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.slice(index + 6, index + 12)
        if (
          !/^\\u[0-9a-fA-F]{4}$/.test(next) ||
          Number.parseInt(next.slice(2), 16) < 0xdc00 ||
          Number.parseInt(next.slice(2), 16) > 0xdfff
        ) {
          failures.add("surrogate", "high surrogate is not followed by a low surrogate")
          if (next.startsWith("\\u") && !/^\\u[0-9a-fA-F]{4}$/.test(next))
            failures.add("escape", "unicode escape must contain exactly four hexadecimal digits")
          index += 6
          continue
        }
        index += 12
        continue
      }
      if (code >= 0xdc00 && code <= 0xdfff) failures.add("surrogate", "low surrogate has no preceding high surrogate")
      index += 6
    }
    const token = text.slice(start, Math.min(index + 1, text.length))
    let cursor = index + 1
    while (text[cursor] !== undefined && " \t\r\n".includes(text[cursor])) cursor++
    if (objectKeys.length && text[cursor] === ":") {
      try {
        const key: unknown = JSON.parse(token)
        if (typeof key === "string") {
          if (objectKeys.at(-1)!.has(key)) failures.add("duplicate_member", key)
          objectKeys.at(-1)!.add(key)
        }
      } catch {
        // malformed keys are represented by the JSON candidate below.
      }
    }
    string = false
    index++
  }
}

class Parser {
  private index = 0
  constructor(
    private readonly text: string,
    private readonly failures: Failures,
  ) {}
  parse() {
    const value = this.value()
    this.space()
    if (this.index !== this.text.length) throw new Error("json")
    return value
  }
  private space() {
    while (this.text[this.index] !== undefined && " \t\r\n".includes(this.text[this.index])) this.index++
  }
  private value(): unknown {
    this.space()
    const character = this.text[this.index]
    if (character === "{") return this.object()
    if (character === "[") return this.array()
    if (character === '"') return this.string()
    if (character === "t" && this.take("true")) return true
    if (character === "f" && this.take("false")) return false
    if (character === "n" && this.take("null")) return null
    if (character === "-" || /[0-9]/.test(character ?? "")) return this.number()
    throw new Error("json")
  }
  private take(token: string) {
    if (!this.text.startsWith(token, this.index)) return false
    this.index += token.length
    return true
  }
  private object() {
    this.index++
    this.space()
    const result: Record<string, unknown> = Object.create(null)
    if (this.text[this.index] === "}") {
      this.index++
      return result
    }
    for (;;) {
      this.space()
      if (this.text[this.index] !== '"') throw new Error("json")
      const key = this.string()
      this.space()
      if (this.text[this.index++] !== ":") throw new Error("json")
      const duplicate = Object.hasOwn(result, key)
      const value = this.value()
      if (duplicate) this.failures.add("duplicate_member", key)
      result[key] = value
      this.space()
      if (this.text[this.index] === "}") {
        this.index++
        return result
      }
      if (this.text[this.index++] !== ",") throw new Error("json")
    }
  }
  private array() {
    this.index++
    this.space()
    const result: unknown[] = []
    if (this.text[this.index] === "]") {
      this.index++
      return result
    }
    for (;;) {
      result.push(this.value())
      this.space()
      if (this.text[this.index] === "]") {
        this.index++
        return result
      }
      if (this.text[this.index++] !== ",") throw new Error("json")
    }
  }
  private string() {
    this.index++
    let result = ""
    while (this.index < this.text.length) {
      const character = this.text[this.index++]
      if (character === '"') return result
      if (character < " ") throw new Error("json")
      if (character !== "\\") {
        result += character
        continue
      }
      const escape = this.text[this.index++]
      const simple: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      }
      if (escape in simple) {
        result += simple[escape]
        continue
      }
      if (escape !== "u") throw new Error("json")
      const hex = this.text.slice(this.index, this.index + 4)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("json")
      this.index += 4
      const code = Number.parseInt(hex, 16)
      if (code >= 0xd800 && code <= 0xdbff) {
        if (this.text.slice(this.index, this.index + 2) !== "\\u") throw new Error("json")
        const low = this.text.slice(this.index + 2, this.index + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(low) || Number.parseInt(low, 16) < 0xdc00 || Number.parseInt(low, 16) > 0xdfff)
          throw new Error("json")
        this.index += 6
        result += String.fromCodePoint(0x10000 + (code - 0xd800) * 0x400 + Number.parseInt(low, 16) - 0xdc00)
        continue
      }
      if (code >= 0xdc00 && code <= 0xdfff) throw new Error("json")
      result += String.fromCodePoint(code)
    }
    throw new Error("json")
  }
  private number() {
    const start = this.index
    if (this.text[this.index] === "-") this.index++
    if (this.text[this.index] === "0") this.index++
    else if (/[1-9]/.test(this.text[this.index] ?? "")) while (/[0-9]/.test(this.text[this.index] ?? "")) this.index++
    else throw new Error("json")
    if (this.text[this.index] === "." || this.text[this.index] === "e" || this.text[this.index] === "E") {
      this.failures.add("number", "floats, exponents, and negative zero are forbidden")
      while (/[0-9eE+-.]/.test(this.text[this.index] ?? "")) this.index++
      return 0
    }
    const token = this.text.slice(start, this.index)
    if (token === "-0") this.failures.add("number", "floats, exponents, and negative zero are forbidden")
    const value = Number(token)
    if (Math.abs(value) > MAX_SAFE_INTEGER) this.failures.add("integer_range", token)
    return value
  }
}

export function parseStrictJson(raw: unknown, registry = errorRegistry): unknown {
  if (!(raw instanceof Uint8Array)) return registry.refuse("input_type", typeof raw)
  const bytes = raw
  const failures = new Failures(registry)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) failures.add("bom", "BOM is forbidden")
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch (error) {
    failures.add("utf8", error instanceof Error ? error.message : String(error))
    failures.refuseIfAny()
    throw error
  }
  lexicalFailures(text, failures)
  let value: unknown
  try {
    value = new Parser(text, failures).parse()
  } catch (error) {
    failures.add("json", error instanceof Error ? error.message : String(error))
    value = undefined
  }
  failures.refuseIfAny()
  return value
}

export function parseCanonicalPayload(raw: unknown, registry = errorRegistry) {
  const value = parseStrictJson(raw, registry)
  if (!(raw instanceof Uint8Array)) return registry.refuse("input_type", typeof raw)
  const bytes = raw
  if (!Buffer.from(bytes).equals(Buffer.from(canonicalPayloadBytes(value, registry)))) {
    registry.refuse("canonical", "raw bytes differ from canonical serialization")
  }
  return value
}

const fields = {
  spec: [
    "version",
    "domain",
    "task",
    "revision",
    "semantics",
    "scope",
    "answers",
    "observable_outcomes",
    "non_goals",
    "oracle_provenance",
    "ids",
  ],
  scope: ["include", "exclude"],
  ids: ["question", "rule", "transition", "outcome", "error", "test", "mapping"],
  manifest: ["version", "domain", "a_digest", "artifacts", "exemptions"],
  artifacts: [
    "pseudocode_flow",
    "protected",
    "invocation",
    "expected_values",
    "baselines",
    "negative_controls",
    "trace_projections",
    "sidecars",
  ],
  invocation: ["argv"],
  artifact: ["path", "digest"],
  exemption: ["path", "class", "reason", "why_no_discriminating_red"],
  envelope: ["version", "payload_type", "payload", "key_id", "signature"],
  approval: [
    "version",
    "domain",
    "task",
    "revision",
    "subject_digest",
    "base_digest",
    "a_digest",
    "b_digest",
    "principal",
    "key",
    "role",
    "nonce",
    "journal_predecessor",
    "time_window",
    "capability_request",
    "profile_digests",
  ],
  window: ["not_before", "not_after"],
  capability: [
    "executable",
    "argv",
    "cwd",
    "roots",
    "actions",
    "environment",
    "network",
    "secret",
    "commit",
    "subagent",
  ],
  environment: ["allow"],
  network: ["allow", "hosts"],
  secret: ["allow", "names"],
  commit: ["allow"],
  subagent: ["allow", "max_children"],
  profiles: ["base", "policy", "generator", "harness"],
} as const

export function validateSpecPacket(value: unknown, registry = errorRegistry) {
  const candidates = new Failures(registry)
  if (isObject(value)) {
    if ("version" in value && value.version !== "spec-packet-v1") candidates.add("version", String(value.version))
    if (Object.keys(value).length !== fields.spec.length || fields.spec.some((field) => !(field in value)))
      candidates.add("shape", "object has missing or extra fields")
  }
  candidates.refuseIfAny()
  const packet = requireObject(value, fields.spec, registry)
  if (packet.version !== "spec-packet-v1") registry.refuse("version", String(packet.version))
  requireString(packet.domain, registry)
  requireString(packet.task, registry)
  requireInteger(packet.revision, registry)
  for (const name of ["semantics", "observable_outcomes", "non_goals"]) requireStrings(packet[name], registry)
  const scope = requireObject(packet.scope, fields.scope, registry)
  requireStrings(scope.include, registry)
  requireStrings(scope.exclude, registry)
  if (
    !isObject(packet.answers) ||
    Object.entries(packet.answers).some(([key, item]) => typeof key !== "string" || typeof item !== "string")
  )
    registry.refuse("shape", "answers must map strings to strings")
  if (
    !isObject(packet.oracle_provenance) ||
    Object.entries(packet.oracle_provenance).some(
      ([key, item]) =>
        typeof key !== "string" || !["human", "domain-rule", "requirement", "observed-only"].includes(String(item)),
    )
  )
    registry.refuse("shape", "oracle provenance is invalid")
  const ids = requireObject(packet.ids, fields.ids, registry)
  const idFailures = new Failures(registry)
  const seen = new Set<string>()
  for (const list of Object.values(ids))
    for (const id of requireStrings(list, registry)) {
      if (!id.trim()) idFailures.add("id_grammar", "ID must not be blank or whitespace-only")
      if (seen.has(id)) idFailures.add("id_duplicate", id)
      seen.add(id)
    }
  idFailures.refuseIfAny()
  return packet
}

function collectManifest(value: unknown, failures: Failures) {
  if (isObject(value)) {
    if ("version" in value && value.version !== "generated-artifact-manifest-v1")
      failures.add("version", String(value.version))
    if (!digestPattern.test(String(value.a_digest))) failures.add("digest", String(value.a_digest))
  }
  if (
    !isObject(value) ||
    Object.keys(value).length !== fields.manifest.length ||
    fields.manifest.some((field) => !(field in value))
  ) {
    failures.add("shape", "object has missing or extra fields")
    return
  }
  const artifacts = value.artifacts
  if (
    !isObject(artifacts) ||
    Object.keys(artifacts).length !== fields.artifacts.length ||
    fields.artifacts.some((field) => !(field in artifacts))
  ) {
    failures.add("shape", "object has missing or extra fields")
    return
  }
  for (const name of [
    "pseudocode_flow",
    "protected",
    "expected_values",
    "baselines",
    "negative_controls",
    "trace_projections",
    "sidecars",
  ]) {
    const rows = artifacts[name]
    if (!Array.isArray(rows)) {
      failures.add("shape", "artifact set must be an array")
      continue
    }
    for (const row of rows) {
      if (
        !isObject(row) ||
        Object.keys(row).length !== fields.artifact.length ||
        fields.artifact.some((field) => !(field in row))
      )
        failures.add("shape", "object has missing or extra fields")
      else {
        if (typeof row.path !== "string" || !row.path) failures.add("shape", "required string is absent or empty")
        if (!digestPattern.test(String(row.digest))) failures.add("digest", String(row.digest))
      }
    }
  }
  const invocation = artifacts.invocation
  if (!isObject(invocation) || Object.keys(invocation).length !== fields.invocation.length || !("argv" in invocation))
    failures.add("shape", "object has missing or extra fields")
  else if (!isStringArray(invocation.argv)) failures.add("shape", "expected a string array")
  if (!Array.isArray(value.exemptions)) {
    failures.add("shape", "exemptions must be an array")
    return
  }
  for (const row of value.exemptions) {
    if (
      !isObject(row) ||
      Object.keys(row).length !== fields.exemption.length ||
      fields.exemption.some((field) => !(field in row))
    ) {
      failures.add("shape", "object has missing or extra fields")
      continue
    }
    for (const name of ["path", "reason", "why_no_discriminating_red"]) {
      if (typeof row[name] !== "string" || !row[name]) failures.add("shape", "required string is absent or empty")
    }
    if (!["generated", "vendor", "docs", "nonbehavioral"].includes(String(row.class)))
      failures.add("shape", "exemption class is invalid")
  }
}

export function validateGeneratedArtifactManifest(value: unknown, specPacket?: unknown, registry = errorRegistry) {
  const candidates = new Failures(registry)
  collectManifest(value, candidates)
  candidates.refuseIfAny()
  const manifest = requireObject(value, fields.manifest, registry)
  if (manifest.version !== "generated-artifact-manifest-v1") registry.refuse("version", String(manifest.version))
  requireString(manifest.domain, registry)
  requireDigest(manifest.a_digest, registry)
  const artifacts = requireObject(manifest.artifacts, fields.artifacts, registry)
  for (const name of [
    "pseudocode_flow",
    "protected",
    "expected_values",
    "baselines",
    "negative_controls",
    "trace_projections",
    "sidecars",
  ])
    for (const row of Array.isArray(artifacts[name])
      ? artifacts[name]
      : registry.refuse("shape", "artifact set must be an array")) {
      const checked = requireObject(row, fields.artifact, registry)
      requireString(checked.path, registry)
      requireDigest(checked.digest, registry)
    }
  requireStrings(requireObject(artifacts.invocation, fields.invocation, registry).argv, registry)
  if (!Array.isArray(manifest.exemptions)) return registry.refuse("shape", "exemptions must be an array")
  for (const row of manifest.exemptions) {
    const checked = requireObject(row, fields.exemption, registry)
    requireString(checked.path, registry)
    requireString(checked.reason, registry)
    requireString(checked.why_no_discriminating_red, registry)
    if (!["generated", "vendor", "docs", "nonbehavioral"].includes(String(checked.class)))
      registry.refuse("shape", "exemption class is invalid")
  }
  if (
    specPacket !== undefined &&
    manifest.a_digest !== payloadDigest(validateSpecPacket(specPacket, registry), undefined, registry)
  )
    registry.refuse("a_binding", "manifest a_digest does not bind the supplied spec packet")
  return manifest
}

function decodeKey(value: unknown, registry: ErrorRegistry, signature = false): Buffer {
  const pattern = signature ? signaturePattern : keyPattern
  if (typeof value !== "string" || !pattern.test(value))
    registry.refuse(signature ? "signature" : "shape", "invalid ed25519 base64")
  const bytes = Buffer.from(value.slice("ed25519:".length), "base64")
  if (bytes.length !== (signature ? 64 : 32) || `ed25519:${bytes.toString("base64")}` !== value)
    registry.refuse(signature ? "signature" : "shape", "noncanonical ed25519 base64")
  return bytes
}

function validateApprovalPayload(value: unknown, registry: ErrorRegistry) {
  const payload = requireObject(value, fields.approval, registry)
  if (payload.version !== "approval-payload-v1") registry.refuse("version", String(payload.version))
  for (const name of ["domain", "task", "principal", "role", "nonce"]) requireString(payload[name], registry)
  requireInteger(payload.revision, registry)
  for (const name of ["subject_digest", "base_digest", "a_digest", "b_digest"]) requireDigest(payload[name], registry)
  decodeKey(payload.key, registry)
  if (payload.journal_predecessor !== null) requireDigest(payload.journal_predecessor, registry)
  const window = requireObject(payload.time_window, fields.window, registry)
  if (requireInteger(window.not_before, registry) > requireInteger(window.not_after, registry))
    registry.refuse("shape", "journal sequence window is reversed")
  const request = requireObject(payload.capability_request, fields.capability, registry)
  requireString(request.executable, registry)
  requireStrings(request.argv, registry)
  requireString(request.cwd, registry)
  requireStrings(request.roots, registry)
  requireStrings(request.actions, registry)
  requireStrings(requireObject(request.environment, fields.environment, registry).allow, registry)
  const network = requireObject(request.network, fields.network, registry)
  const secret = requireObject(request.secret, fields.secret, registry)
  const commit = requireObject(request.commit, fields.commit, registry)
  const subagent = requireObject(request.subagent, fields.subagent, registry)
  requireStrings(network.hosts, registry)
  requireStrings(secret.names, registry)
  requireInteger(subagent.max_children, registry)
  for (const flag of [network.allow, secret.allow, commit.allow, subagent.allow])
    if (typeof flag !== "boolean") registry.refuse("shape", "capability allow value must be boolean")
  for (const digest of Object.values(requireObject(payload.profile_digests, fields.profiles, registry)))
    requireDigest(digest, registry)
  return payload
}

function publicKey(raw: Buffer) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der",
    type: "spki",
  })
}
function privateKey(raw: Buffer) {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), raw]),
    format: "der",
    type: "pkcs8",
  })
}

export function validateApprovalEnvelope(value: unknown, usedNonces: Iterable<string> = [], registry = errorRegistry) {
  const envelope = requireObject(value, fields.envelope, registry)
  if (envelope.payload_type !== APPROVAL_PAYLOAD_TYPE) registry.refuse("payload_type", String(envelope.payload_type))
  if (envelope.version !== "approval-envelope-v1") registry.refuse("version", String(envelope.version))
  const payload = validateApprovalPayload(envelope.payload, registry)
  const key = decodeKey(envelope.key_id, registry)
  if (envelope.key_id !== payload.key)
    registry.refuse("key_binding", "envelope key_id does not match approval payload key")
  if (new Set(usedNonces).has(String(payload.nonce))) registry.refuse("nonce_reuse", String(payload.nonce))
  try {
    if (
      !verify(
        null,
        pae(APPROVAL_PAYLOAD_TYPE, canonicalPayloadBytes(payload, registry)),
        publicKey(key),
        decodeKey(envelope.signature, registry, true),
      )
    )
      registry.refuse("signature", "signature did not verify")
  } catch (error) {
    registry.refuse("signature", error instanceof Error ? error.message : String(error))
  }
  return envelope
}

export function signApprovalPayload(payload: unknown, privateKeyText: unknown, registry = errorRegistry) {
  const checked = validateApprovalPayload(payload, registry)
  const privateKeyBytes = (() => {
    try {
      return decodeKey(privateKeyText, registry)
    } catch {
      return registry.refuse("signature", "invalid private key")
    }
  })()
  const derived = createPublicKey(privateKey(privateKeyBytes)).export({ format: "der", type: "spki" }) as Buffer
  if (`ed25519:${derived.subarray(-32).toString("base64")}` !== checked.key)
    registry.refuse("relation", "private key does not match approval payload key")
  return `ed25519:${sign(null, pae(APPROVAL_PAYLOAD_TYPE, canonicalPayloadBytes(checked, registry)), privateKey(privateKeyBytes)).toString("base64")}`
}

export function verifyApprovalEnvelope(value: unknown, usedNonces: Iterable<string> = [], registry = errorRegistry) {
  try {
    validateApprovalEnvelope(value, usedNonces, registry)
    return true
  } catch (error) {
    if (error instanceof SpecificationABCError) return false
    throw error
  }
}

export function assertAbcChain(
  specPacket: unknown,
  manifest: unknown,
  envelope: unknown,
  usedNonces: Iterable<string> = [],
  registry = errorRegistry,
) {
  const a = validateSpecPacket(specPacket, registry)
  const b = validateGeneratedArtifactManifest(manifest, undefined, registry)
  const uncheckedEnvelope = requireObject(envelope, fields.envelope, registry)
  const c = validateApprovalPayload(uncheckedEnvelope.payload, registry)
  const failures = new Failures(registry)
  const aDigest = payloadDigest(a, undefined, registry)
  if (b.a_digest !== aDigest || c.a_digest !== aDigest)
    failures.add("a_binding", "A digest does not bind the supplied spec packet")
  if (c.b_digest !== payloadDigest(b, undefined, registry))
    failures.add("b_binding", "B digest does not bind the supplied manifest")
  if (a.domain !== b.domain || a.domain !== c.domain || a.task !== c.task || a.revision !== c.revision)
    failures.add("context_binding", "A, B, and C context must match exactly")
  failures.refuseIfAny()
  validateApprovalEnvelope(uncheckedEnvelope, usedNonces, registry)
}

export function validateSpecPacketBytes(raw: unknown, registry = errorRegistry) {
  return validateSpecPacket(parseCanonicalPayload(raw, registry), registry)
}
export function validateGeneratedArtifactManifestBytes(raw: unknown, specPacket?: unknown, registry = errorRegistry) {
  return validateGeneratedArtifactManifest(parseCanonicalPayload(raw, registry), specPacket, registry)
}
export function validateApprovalEnvelopeBytes(
  raw: unknown,
  usedNonces: Iterable<string> = [],
  registry = errorRegistry,
) {
  return validateApprovalEnvelope(parseCanonicalPayload(raw, registry), usedNonces, registry)
}
