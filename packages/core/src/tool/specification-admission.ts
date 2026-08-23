import { createHash } from "node:crypto"

export const specificationAdmissionFamilies = [
  "core",
  "ranex_local",
  "pty_process",
  "mcp_auth",
  "plugin_provider_network",
  "storage_database",
] as const

export type SpecificationAdmissionFamily = (typeof specificationAdmissionFamilies)[number]
export type SpecificationAdmissionDecision = "allow" | "deny"
export type SpecificationAdmissionCode =
  | "OK"
  | "E-APPROVAL-GRANT-UNISSUED"
  | "E-APPROVAL-EVENT-CHAIN"
  | "E-APPROVAL-WINDOW"
  | "E-APPROVAL-REVOKED"

export interface SpecificationCapabilities {
  readonly executable: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly roots: readonly string[]
  readonly actions: readonly string[]
  readonly environment: { readonly allow: readonly string[] }
  readonly network: { readonly allow: boolean; readonly hosts: readonly string[] }
  readonly secret: { readonly allow: boolean; readonly names: readonly string[] }
  readonly commit: { readonly allow: boolean }
  readonly subagent: { readonly allow: boolean; readonly max_children: number }
}

export interface SpecificationAdmissionRequest {
  readonly version: string
  readonly family: string
  readonly caller_principal_id: string
  readonly caller_key: string
  readonly active_harness_profile_digest: string
  readonly capabilities: SpecificationCapabilities
}

export interface SpecificationGrantFacts {
  readonly grant_id: string
  readonly c_digest: string
  readonly caller_principal_id: string
  readonly caller_key: string
  readonly active_harness_profile_digest: string
  readonly capabilities: SpecificationCapabilities
  readonly not_before: number
  readonly not_after: number
  readonly revoked?: boolean
  readonly observed_event_head: string
  readonly observed_position: number
}

export interface SpecificationAdmissionFacts {
  readonly grant: SpecificationGrantFacts
  readonly observed_caller_principal_id?: string
  readonly observed_caller_key?: string
  readonly observed_event_head?: string
  readonly observed_position?: number
  readonly now?: number
  readonly child_capabilities?: SpecificationCapabilities
}

export interface SpecificationAdmissionRecord {
  readonly version: "effect-admission-v1"
  readonly request_digest: string | null
  readonly capability_digest: string | null
  readonly grant_id: string | null
  readonly c_digest: string | null
  readonly effect_family: string | null
  readonly caller_principal_id: string | null
  readonly caller_key: string | null
  readonly decision: SpecificationAdmissionDecision
  readonly code: SpecificationAdmissionCode
  readonly observed_event_head: string | null
  readonly observed_position: number | null
}

export interface SpecificationAdmissionEnvelope {
  readonly record: SpecificationAdmissionRecord
  readonly identity: string
}

export function evaluateSpecificationAdmission(
  request: SpecificationAdmissionRequest,
  facts: SpecificationAdmissionFacts | undefined,
): SpecificationAdmissionEnvelope {
  const grant = facts?.grant
  const validGrant = isGrant(grant)
  const requestDigest = isRequest(request) ? digest(request) : null
  const capabilityDigest = isRequest(request) ? digest(request.capabilities) : null
  const recordBase = {
    version: "effect-admission-v1" as const,
    request_digest: requestDigest,
    capability_digest: capabilityDigest,
    grant_id: validGrant ? grant.grant_id : null,
    c_digest: validGrant ? grant.c_digest : null,
    effect_family: isRequest(request) ? request.family : null,
    caller_principal_id: validGrant ? grant.caller_principal_id : null,
    caller_key: validGrant ? grant.caller_key : null,
    observed_event_head: validGrant ? grant.observed_event_head : null,
    observed_position: validGrant ? grant.observed_position : null,
  }

  let code: SpecificationAdmissionCode = "OK"
  if (!isRequest(request) || !validGrant || !facts?.observed_event_head || facts?.observed_position === undefined) {
    code = "E-APPROVAL-GRANT-UNISSUED"
  } else if (
    facts.observed_event_head !== grant.observed_event_head ||
    facts.observed_position !== grant.observed_position ||
    (facts.observed_caller_principal_id ?? request.caller_principal_id) !== grant.caller_principal_id ||
    (facts.observed_caller_key ?? request.caller_key) !== grant.caller_key ||
    request.caller_principal_id !== grant.caller_principal_id ||
    request.caller_key !== grant.caller_key
  ) {
    code = "E-APPROVAL-EVENT-CHAIN"
  } else if (grant.revoked) {
    code = "E-APPROVAL-REVOKED"
  } else if ((facts.now ?? facts.observed_position) < grant.not_before || (facts.now ?? facts.observed_position) > grant.not_after) {
    code = "E-APPROVAL-WINDOW"
  } else if (
    !specificationAdmissionFamilies.some((family) => family === request.family) ||
    request.version !== "effect-request-v1" ||
    request.active_harness_profile_digest !== grant.active_harness_profile_digest ||
    !capabilitiesContain(grant.capabilities, request.capabilities) ||
    (facts.child_capabilities !== undefined && (!isCapabilities(facts.child_capabilities) || !capabilitiesContain(request.capabilities, facts.child_capabilities)))
  ) {
    code = "E-APPROVAL-GRANT-UNISSUED"
  }

  const record = deepFreeze({
    ...recordBase,
    decision: (code === "OK" ? "allow" : "deny") as SpecificationAdmissionDecision,
    code,
  })
  return deepFreeze({ record, identity: digest(record) })
}

export const admitSpecification = evaluateSpecificationAdmission

function isRequest(value: unknown): value is SpecificationAdmissionRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "family", "caller_principal_id", "caller_key", "active_harness_profile_digest", "capabilities"])) return false
  return typeof value.version === "string" && typeof value.family === "string" && typeof value.caller_principal_id === "string" && typeof value.caller_key === "string" && typeof value.active_harness_profile_digest === "string" && isCapabilities(value.capabilities)
}

function isGrant(value: unknown): value is SpecificationGrantFacts {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<SpecificationGrantFacts>
  return typeof candidate.grant_id === "string" && typeof candidate.c_digest === "string" && typeof candidate.caller_principal_id === "string" && typeof candidate.caller_key === "string" && typeof candidate.active_harness_profile_digest === "string" && isCapabilities(candidate.capabilities) && typeof candidate.not_before === "number" && typeof candidate.not_after === "number" && typeof candidate.observed_event_head === "string" && typeof candidate.observed_position === "number"
}

function isCapabilities(value: unknown): value is SpecificationCapabilities {
  if (!isRecord(value) || !hasOnlyKeys(value, ["executable", "argv", "cwd", "roots", "actions", "environment", "network", "secret", "commit", "subagent"])) return false
  return typeof value.executable === "string" &&
    isStringArray(value.argv) &&
    typeof value.cwd === "string" &&
    isStringArray(value.roots) &&
    isStringArray(value.actions) &&
    isRecord(value.environment) && hasOnlyKeys(value.environment, ["allow"]) && isStringArray(value.environment.allow) &&
    isRecord(value.network) && hasOnlyKeys(value.network, ["allow", "hosts"]) && typeof value.network.allow === "boolean" && isStringArray(value.network.hosts) &&
    isRecord(value.secret) && hasOnlyKeys(value.secret, ["allow", "names"]) && typeof value.secret.allow === "boolean" && isStringArray(value.secret.names) &&
    isRecord(value.commit) && hasOnlyKeys(value.commit, ["allow"]) && typeof value.commit.allow === "boolean" &&
    isRecord(value.subagent) && hasOnlyKeys(value.subagent, ["allow", "max_children"]) && typeof value.subagent.allow === "boolean" && typeof value.subagent.max_children === "number"
}

function capabilitiesContain(grant: SpecificationCapabilities, request: SpecificationCapabilities) {
  return (
    grant.executable === request.executable &&
    grant.cwd === request.cwd &&
    grant.argv.length === request.argv.length &&
    request.argv.every((item, index) => grant.argv[index] === item) &&
    request.roots.every((item) => grant.roots.includes(item)) &&
    request.actions.every((item) => grant.actions.includes(item)) &&
    request.environment.allow.every((item) => grant.environment.allow.includes(item)) &&
    (!request.network.allow || (grant.network.allow && request.network.hosts.every((item) => grant.network.hosts.includes(item)))) &&
    (!request.secret.allow || (grant.secret.allow && request.secret.names.every((item) => grant.secret.names.includes(item)))) &&
    (!request.commit.allow || grant.commit.allow) &&
    (!request.subagent.allow || grant.subagent.allow) &&
    request.subagent.max_children <= grant.subagent.max_children
  )
}

function digest(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalize(item)]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys)
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => allowed.has(key))
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.freeze(value)
  Object.values(value).forEach((item) => deepFreeze(item))
  return value
}
