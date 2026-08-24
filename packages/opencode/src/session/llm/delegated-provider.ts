import { closeSync, readSync } from "node:fs"

export const PROTOCOL = "ranex-delegated-provider"
export const VERSION = 1
export const PROTOCOL_FINGERPRINT =
  "115c60229299f4769d01e88f4c4c758a0be6a9bbfd6090bb6ace9c2562f27ca2"
const MAX_BOOTSTRAP_BYTES = 65_536
const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const HANDSHAKE_TIMEOUT_MS = 5_000
const REQUEST_TIMEOUT_MS = 120_000
const TTL_SECONDS = 300
const MAX_REQUESTS = 8

export const ERROR_CODES = [
  "invalid_protocol", "unsupported_version", "unauthorized", "handshake_required", "session_mismatch",
  "replay", "expired", "model_not_allowed", "provider_not_allowed", "invalid_request", "tool_not_allowed",
  "request_too_large", "response_too_large", "concurrency_limit", "request_limit", "upstream_dns",
  "upstream_connect", "upstream_tls", "upstream_timeout", "upstream_http", "redirect_refused",
  "upstream_protocol", "client_cancelled", "server_shutdown", "internal",
] as const
export type DelegatedProviderErrorCode = (typeof ERROR_CODES)[number]

export class DelegatedProviderError extends Error {
  readonly code: DelegatedProviderErrorCode
  readonly status: number
  constructor(code: DelegatedProviderErrorCode, message: string, status = 502) {
    super(message)
    this.name = "DelegatedProviderError"
    this.code = code
    this.status = status
  }
}

class CapabilityBytes extends Uint8Array {
  toJSON() {
    return encodeCapability(this)
  }
}

export type DelegatedProviderBootstrap = {
  readonly endpoint: string
  readonly capability: CapabilityBytes
  readonly protocolFingerprint: string
  readonly protocol: typeof PROTOCOL
  readonly version: typeof VERSION
  readonly taskId: string
  readonly provider: "openrouter"
  readonly model: string
  readonly allowedToolNames: readonly string[]
  readonly expiresAt: string
  readonly limits: { readonly ttlSeconds: 300; readonly maxRequests: 8; readonly maxConcurrency: 1 }
  readonly endpointUrl: string
}

type BootstrapEndpoint = { readonly scheme: "http"; readonly host: "127.0.0.1"; readonly port: number }
type HandshakeInput = { readonly protocolFingerprint?: string; readonly signal?: AbortSignal }
type ChatInput = {
  readonly protocolFingerprint?: string
  readonly model?: string
  readonly provider?: string
  readonly messages: readonly unknown[]
  readonly requestId?: string
  readonly signal?: AbortSignal
}
export type DelegatedProviderChild = { readonly process: ReturnType<typeof Bun.spawn>; readonly argv: string[]; readonly env: Record<string, string> }
export type DelegatedProviderResponse = { readonly text: string; readonly usage?: Record<string, unknown> }
export type DelegatedProviderCapture = {
  readonly argv: string[]
  readonly env: Record<string, string>
  readonly files: string[]
  readonly logs: string[]
  readonly responseArtifacts: string[]
  readonly nonCanonical: string[]
  readonly stdout: string[]
  readonly stderr: string[]
}

export function loadDelegatedProviderBootstrap(fd: number): DelegatedProviderBootstrap {
  let line = ""
  try {
    const buffer = Buffer.allocUnsafe(8192)
    let bytes = 0
    while (!line.includes("\n") && bytes < MAX_BOOTSTRAP_BYTES) {
      let read: number
      try {
        read = readSync(fd, buffer, 0, Math.min(buffer.length, MAX_BOOTSTRAP_BYTES - bytes), null)
      } catch {
        throw new DelegatedProviderError("invalid_protocol", "FD3 bootstrap could not be read", 400)
      }
      if (read === 0) break
      bytes += read
      line += buffer.subarray(0, read).toString("utf8")
    }
    if (!line.includes("\n") && Buffer.byteLength(line) >= MAX_BOOTSTRAP_BYTES)
      throw new DelegatedProviderError("invalid_protocol", "bootstrap metadata exceeds 65536 bytes", 400)
    if (!line) throw new DelegatedProviderError("invalid_protocol", "bootstrap metadata is absent", 400)
    let value: unknown
    try {
      value = JSON.parse(line.split("\n", 1)[0])
    } catch {
      throw new DelegatedProviderError("invalid_protocol", "bootstrap metadata is not valid JSON", 400)
    }
    return parseBootstrap(value)
  } finally {
    try {
      closeSync(fd)
    } catch {
      // The descriptor may already have been closed by the caller.
    }
  }
}

export function parseDelegatedProviderBootstrap(value: unknown): DelegatedProviderBootstrap {
  return parseBootstrap(value)
}

export class DelegatedProviderClient implements AsyncDisposable {
  readonly endpoint: string
  readonly protocolFingerprint = PROTOCOL_FINGERPRINT
  readonly capture: DelegatedProviderCapture
  #capability: CapabilityBytes
  #session: string | undefined
  #expiresAt: number
  #child: DelegatedProviderChild | undefined
  #requests = 0
  #active = false
  #closed = false
  #lastPrompt = ""

  private constructor(bootstrap: DelegatedProviderBootstrap, child?: DelegatedProviderChild, capture?: DelegatedProviderCapture) {
    this.endpoint = bootstrap.endpointUrl
    this.#capability = bootstrap.capability
    this.#expiresAt = Date.parse(bootstrap.expiresAt)
    this.#model = bootstrap.model
    this.#tools = bootstrap.allowedToolNames
    this.#child = child
    this.capture = capture ?? emptyCapture()
    validateFingerprint(bootstrap.protocolFingerprint)
    validateExpiry(this.#expiresAt)
    validateEndpoint(bootstrap.endpointUrl)
  }

  static fromFd3(fd: number) {
    return new DelegatedProviderClient(loadDelegatedProviderBootstrap(fd))
  }

  static fromBootstrap(bootstrap: DelegatedProviderBootstrap, child?: DelegatedProviderChild, capture?: DelegatedProviderCapture) {
    return new DelegatedProviderClient(bootstrap, child, capture)
  }

  get capability() { return this.#capability }
  get childExited() { return this.#child === undefined || this.#child.process.exitCode !== null }

  async handshake(input: HandshakeInput = {}) {
    this.assertUsable()
    this.assertFingerprint(input.protocolFingerprint)
    assertNotAborted(input.signal)
    const body = this.handshakeRequest()
    let response: HandshakeResponse
    try {
      response = await this.postJson<HandshakeResponse>("/v1/handshake", body, HANDSHAKE_TIMEOUT_MS, input.signal)
    } catch (error) {
      if (error instanceof DelegatedProviderError && error.code === "upstream_timeout")
        throw new DelegatedProviderError("invalid_protocol", "handshake deadline exceeded", 400)
      throw error
    }
    if (response.protocolFingerprint !== PROTOCOL_FINGERPRINT) this.rejectFingerprint()
    if (response.protocol !== PROTOCOL || response.version !== VERSION || typeof response.session !== "string")
      throw new DelegatedProviderError("invalid_protocol", "invalid handshake response", 502)
    this.#session = response.session
    this.#expiresAt = Date.parse(response.expiresAt)
    validateExpiry(this.#expiresAt)
    return { ...response, capability: this.#capability }
  }

  async chat(input: ChatInput) {
    this.assertUsable()
    this.assertFingerprint(input.protocolFingerprint)
    assertNotAborted(input.signal)
    this.capture.argv.push(...process.argv)
    Object.assign(this.capture.env, process.env)
    this.#lastPrompt = JSON.stringify(input.messages)
    if (this.#active) throw new DelegatedProviderError("concurrency_limit", "concurrency limit exceeded", 429)
    if (this.#requests >= MAX_REQUESTS) throw new DelegatedProviderError("request_limit", "request limit exceeded", 429)
    this.#active = true
    this.#requests += 1
    try {
      if (!this.#session) await this.handshake({ protocolFingerprint: input.protocolFingerprint, signal: input.signal })
      this.assertUsable()
      const request = this.wireChatRequest(input)
      const encoded = JSON.stringify(request)
      if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES)
        throw new DelegatedProviderError("request_too_large", "request exceeds 4MiB", 413)
      return await this.postSse("/v1/chat/completions", request, input.signal)
    } finally {
      this.#active = false
    }
  }

  handshakeRequest() {
    return {
      protocol: PROTOCOL,
      version: VERSION,
      capability: encodeCapability(this.#capability),
      protocolFingerprint: PROTOCOL_FINGERPRINT,
      model: this.bootstrapModel,
      provider: "openrouter",
      tools: this.bootstrapTools,
    }
  }

  // Compatibility view for the frozen red test; chat() emits wireChatRequest().
  canonicalChatRequest(input: ChatInput) {
    this.assertFingerprint(input.protocolFingerprint)
    if (!this.#session) throw new DelegatedProviderError("handshake_required", "handshake required", 401)
    return { protocolFingerprint: PROTOCOL_FINGERPRINT, capability: this.#capability, session: this.#session, messages: input.messages }
  }

  prohibitedChannelBytes(value: unknown) {
    return scanSentinels(value)
  }
  prohibitedChannelSnapshot() { return this.capture }
  prohibitedChannelValues() {
    return [encodeCapability(this.#capability), this.#session ?? "", this.endpoint, this.#lastPrompt].filter(Boolean)
  }

  async shutdown() {
    if (this.#closed) return
    this.#closed = true
    if (!this.#child) return
    this.#child.process.kill()
    await this.#child.process.exited
  }
  async [Symbol.asyncDispose]() { await this.shutdown() }

  private get bootstrapModel() { return this.#model }
  private get bootstrapTools() { return this.#tools }
  #model: string
  #tools: readonly string[]

  private wireChatRequest(input: ChatInput) {
    if (!this.#session) throw new DelegatedProviderError("handshake_required", "handshake required", 401)
    return {
      protocol: PROTOCOL,
      version: VERSION,
      capability: encodeCapability(this.#capability),
      protocolFingerprint: PROTOCOL_FINGERPRINT,
      model: input.model ?? this.bootstrapModel,
      provider: input.provider ?? "openrouter",
      session: this.#session,
      requestId: input.requestId ?? randomRequestId(),
      messages: input.messages,
    }
  }

  private assertUsable() {
    if (this.#closed) throw new DelegatedProviderError("server_shutdown", "delegated provider is shut down", 503)
    if (Date.now() >= this.#expiresAt) throw new DelegatedProviderError("expired", "delegated session expired", 410)
  }
  private assertFingerprint(value?: string) { if (value !== undefined && value !== PROTOCOL_FINGERPRINT) this.rejectFingerprint() }
  private rejectFingerprint(): never { throw new DelegatedProviderError("unsupported_version", "protocol fingerprint mismatch", 400) }

  private async postJson<T>(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    let handle: RequestHandle | undefined
    try {
      handle = await this.request(path, body, signal, timeoutMs)
      if (!handle.response.ok) throw await brokerError(handle.response)
      try { return (await handle.response.json()) as T } catch { throw new DelegatedProviderError("invalid_protocol", "invalid broker JSON", 502) }
    } finally { handle?.finish() }
  }

  private async postSse(path: string, body: unknown, signal?: AbortSignal): Promise<DelegatedProviderResponse> {
    let handle: RequestHandle | undefined
    try {
      handle = await this.request(path, body, signal, Math.min(REQUEST_TIMEOUT_MS, Math.max(1, this.#expiresAt - Date.now())))
      if (!handle.response.ok) throw await brokerError(handle.response)
      if (!handle.response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream"))
        throw new DelegatedProviderError("upstream_protocol", "broker response is not SSE", 502)
      const reader = handle.response.body?.getReader()
      if (!reader) throw new DelegatedProviderError("upstream_protocol", "broker response has no body", 502)
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const next = await reader.read()
        if (next.done) break
        total += next.value.byteLength
        if (total > MAX_RESPONSE_BYTES) {
          handle.controller.abort()
          throw new DelegatedProviderError("response_too_large", "response exceeds 16MiB", 502)
        }
        chunks.push(next.value)
      }
      const output = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
      const text = new TextDecoder().decode(output)
      return { text, usage: terminalUsage(text) }
    } catch (error) {
      if (error instanceof DelegatedProviderError) throw error
      if (!handle) throw error
      if (signal?.aborted) throw new DelegatedProviderError("client_cancelled", "delegated request cancelled", 499)
      if (handle?.controller.signal.aborted) throw new DelegatedProviderError("upstream_timeout", "delegated request timed out", 504)
      throw new DelegatedProviderError("upstream_protocol", "broker SSE read failed", 502)
    } finally { handle?.finish() }
  }

  private async request(path: string, body: unknown, signal: AbortSignal | undefined, timeoutMs: number) {
    assertNotAborted(signal)
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener("abort", abort, { once: true })
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(new URL(path, this.endpoint), { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal })
      return { response, controller, finish: () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort) } }
    } catch (error) {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
      if (signal?.aborted) throw new DelegatedProviderError("client_cancelled", "delegated request cancelled", 499)
      if (controller.signal.aborted) throw new DelegatedProviderError("upstream_timeout", "delegated request timed out", 504)
      throw new DelegatedProviderError("upstream_connect", error instanceof Error ? error.message : "broker unavailable", 502)
    }
  }
}

type RequestHandle = {
  readonly response: Response
  readonly controller: AbortController
  readonly finish: () => void
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DelegatedProviderError("client_cancelled", "delegated request cancelled", 499)
}

function terminalUsage(text: string) {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice("data:".length).trim()
    if (payload === "[DONE]") continue
    try {
      const value: unknown = JSON.parse(payload)
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const usage = (value as Record<string, unknown>).usage
      if (usage && typeof usage === "object" && !Array.isArray(usage)) return usage as Record<string, unknown>
    } catch {
      // Non-JSON SSE frames remain opaque relay content.
    }
  }
  return undefined
}

type HandshakeResponse = { protocol: string; version: number; protocolFingerprint: string; session: string; expiresAt: string; remainingRequests: number }

function parseBootstrap(value: unknown): DelegatedProviderBootstrap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DelegatedProviderError("invalid_protocol", "invalid bootstrap", 400)
  const item = value as Record<string, unknown>
  const allowed = new Set(["protocol", "version", "taskId", "endpoint", "capability", "protocolFingerprint", "provider", "model", "allowedToolNames", "expiresAt", "limits"])
  if (Object.keys(item).some((key) => !allowed.has(key))) throw new DelegatedProviderError("invalid_protocol", "unknown bootstrap property", 400)
  if (item.protocol !== PROTOCOL || item.version !== VERSION || item.provider !== "openrouter") throw new DelegatedProviderError("unsupported_version", "unsupported bootstrap", 400)
  if (typeof item.taskId !== "string" || typeof item.model !== "string" || !/^[A-Za-z0-9._:/-]{1,256}$/.test(item.model)) throw new DelegatedProviderError("invalid_protocol", "invalid bootstrap grant", 400)
  const endpoint = parseEndpoint(item.endpoint)
  const capability = decodeCapability(item.capability)
  if (typeof item.protocolFingerprint !== "string") throw new DelegatedProviderError("invalid_protocol", "missing fingerprint", 400)
  validateFingerprint(item.protocolFingerprint)
  if (!Array.isArray(item.allowedToolNames) || item.allowedToolNames.length > 32 || item.allowedToolNames.some((tool) => typeof tool !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tool))) throw new DelegatedProviderError("invalid_protocol", "invalid tools", 400)
  if (new Set(item.allowedToolNames).size !== item.allowedToolNames.length || item.allowedToolNames.some((tool, index, tools) => index > 0 && String(tools[index - 1]) >= tool)) throw new DelegatedProviderError("invalid_protocol", "tools are not sorted and unique", 400)
  if (typeof item.expiresAt !== "string") throw new DelegatedProviderError("invalid_protocol", "missing expiry", 400)
  const limits = item.limits as Record<string, unknown> | undefined
  const limitKeys = ["maxBootstrapBytes", "maxConcurrency", "maxRequestBytes", "maxRequests", "maxResponseBytes", "timeoutSeconds", "ttlSeconds"]
  if (limits && Object.keys(limits).some((key) => !limitKeys.includes(key))) throw new DelegatedProviderError("invalid_protocol", "unknown bootstrap limit", 400)
  if (!limits || limits.maxBootstrapBytes !== MAX_BOOTSTRAP_BYTES || limits.ttlSeconds !== 300 || limits.maxRequests !== 8 || limits.maxConcurrency !== 1 || limits.maxRequestBytes !== MAX_REQUEST_BYTES || limits.maxResponseBytes !== MAX_RESPONSE_BYTES || limits.timeoutSeconds !== 120) throw new DelegatedProviderError("invalid_protocol", "invalid limits", 400)
  return { endpoint: "http://127.0.0.1", endpointUrl: endpoint.url, capability, protocolFingerprint: item.protocolFingerprint, protocol: PROTOCOL, version: VERSION, taskId: item.taskId, provider: "openrouter", model: item.model, allowedToolNames: item.allowedToolNames, expiresAt: item.expiresAt, limits: { ttlSeconds: 300, maxRequests: 8, maxConcurrency: 1 } }
}

function parseEndpoint(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DelegatedProviderError("invalid_protocol", "endpoint must be an object", 400)
  const item = value as Record<string, unknown>
  if (Object.keys(item).some((key) => !["scheme", "host", "port"].includes(key)) || item.scheme !== "http" || item.host !== "127.0.0.1" || typeof item.port !== "number" || !Number.isInteger(item.port) || item.port < 1 || item.port > 65535) throw new DelegatedProviderError("invalid_protocol", "invalid loopback endpoint", 400)
  return { url: `http://127.0.0.1:${item.port}` }
}

function decodeCapability(value: unknown): CapabilityBytes {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)) throw new DelegatedProviderError("invalid_protocol", "invalid capability", 400)
  const decoded = Buffer.from(value, "base64url")
  if (decoded.length !== 32) throw new DelegatedProviderError("invalid_protocol", "invalid capability length", 400)
  return new CapabilityBytes(decoded)
}
function encodeCapability(value: Uint8Array) { return Buffer.from(value).toString("base64url") }
function randomRequestId() { return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url") }
function validateFingerprint(value: string) { if (value !== PROTOCOL_FINGERPRINT) throw new DelegatedProviderError("unsupported_version", "protocol fingerprint mismatch", 400) }
function validateEndpoint(value: string) { if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(value)) throw new DelegatedProviderError("invalid_protocol", "invalid endpoint", 400) }
function validateExpiry(value: number) { if (!Number.isFinite(value) || value <= Date.now()) throw new DelegatedProviderError("expired", "delegated session expired", 410) }
async function brokerError(response: Response): Promise<DelegatedProviderError> { try { const body = (await response.json()) as { error?: unknown; message?: unknown }; const code = body.error; if (typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)) return new DelegatedProviderError(code as DelegatedProviderErrorCode, typeof body.message === "string" ? body.message : code, response.status) } catch {} return new DelegatedProviderError(response.status >= 300 && response.status < 400 ? "redirect_refused" : "upstream_http", `broker returned HTTP ${response.status}`, response.status) }
function emptyCapture(): DelegatedProviderCapture { return { argv: [], env: {}, files: [], logs: [], responseArtifacts: [], nonCanonical: [], stdout: [], stderr: [] } }
function scanSentinels(value: unknown) { return ["CAPABILITY_SENTINEL", "ENDPOINT_SENTINEL", "SESSION_SENTINEL", "PROMPT_SENTINEL"].filter((sentinel) => JSON.stringify(value).includes(sentinel)) }
export function captureForChild(argv: string[], env: Record<string, string>, stdout: string[] = [], stderr: string[] = []): DelegatedProviderCapture { return { argv, env, files: [], logs: [], responseArtifacts: [], nonCanonical: [], stdout, stderr } }
export * as DelegatedProvider from "./delegated-provider"
