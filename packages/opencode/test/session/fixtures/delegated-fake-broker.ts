import { DelegatedProviderClient, captureForChild, parseDelegatedProviderBootstrap } from "@/session/llm/delegated-provider"
import { readFileSync } from "node:fs"

const fingerprint = "115c60229299f4769d01e88f4c4c758a0be6a9bbfd6090bb6ace9c2562f27ca2"
const capability = "CAPABILITY_REAL_ISSUE106_000000000000000000"
const session = "SESSION_REAL_ISSUE106"
type FakeBrokerOptions = { handshakeError?: string; chatError?: string; chatDelayMs?: number; responseTooLarge?: boolean }

if (import.meta.main) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
    if (request.method !== "POST") return new Response(JSON.stringify({ error: "invalid_protocol" }), { status: 400 })
    const url = new URL(request.url)
    const body = (await request.json()) as Record<string, unknown>
    if (url.pathname === "/v1/handshake") {
      if (process.env.FAKE_HANDSHAKE_ERROR) return Response.json({ error: process.env.FAKE_HANDSHAKE_ERROR, message: process.env.FAKE_HANDSHAKE_ERROR }, { status: 500 })
      if (body.protocol !== "ranex-delegated-provider" || body.version !== 1 || body.protocolFingerprint !== fingerprint)
        return Response.json({ error: "unsupported_version", message: "protocol version is not supported" }, { status: 400 })
      return Response.json({ protocol: "ranex-delegated-provider", version: 1, protocolFingerprint: fingerprint, session, expiresAt: "2030-01-01T00:05:00Z", remainingRequests: 8 })
    }
    if (url.pathname === "/v1/chat/completions") {
      if (process.env.FAKE_CHAT_ERROR) {
        const status = process.env.FAKE_CHAT_ERROR === "redirect_refused" ? 302 : 500
        return Response.json({ error: process.env.FAKE_CHAT_ERROR, message: process.env.FAKE_CHAT_ERROR }, { status })
      }
      if (process.env.FAKE_CHAT_DELAY_MS) await Bun.sleep(Number(process.env.FAKE_CHAT_DELAY_MS))
      if (body.protocol !== "ranex-delegated-provider" || body.version !== 1 || body.session !== session)
        return Response.json({ error: "invalid_request", message: "invalid chat request" }, { status: 400 })
      if (process.env.FAKE_RESPONSE_TOO_LARGE) return new Response("x".repeat(16 * 1024 * 1024 + 1), { headers: { "content-type": "text/event-stream" } })
      return new Response('data: {"id":"chatcmpl-text-delta","object":"chat.completion.chunk","choices":[{"delta":{"content":"ok"},"index":0}]}\n\ndata: {"usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
    }
    return Response.json({ error: "invalid_protocol" }, { status: 400 })
    },
  })

  process.stdout.write(`${JSON.stringify({ port: server.port })}\n`)
  process.on("SIGTERM", () => server.stop())
}

export async function spawnFakeBroker(options: FakeBrokerOptions = {}) {
  const argv = [process.execPath, import.meta.filename]
  const env = {
    ...(options.handshakeError ? { FAKE_HANDSHAKE_ERROR: options.handshakeError } : {}),
    ...(options.chatError ? { FAKE_CHAT_ERROR: options.chatError } : {}),
    ...(options.chatDelayMs === undefined ? {} : { FAKE_CHAT_DELAY_MS: String(options.chatDelayMs) }),
    ...(options.responseTooLarge ? { FAKE_RESPONSE_TOO_LARGE: "1" } : {}),
  }
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env })
  const stdout: string[] = []
  const stderr: string[] = []
  void drain(child.stderr, stderr)
  const reader = child.stdout.getReader()
  let text = ""
  while (!text.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error("fake broker exited before bootstrap")
    const decoded = new TextDecoder().decode(chunk.value)
    stdout.push(decoded)
    text += decoded
  }
  const metadata = JSON.parse(text.split("\n", 1)[0]) as { port: number }
  const bootstrap = {
    protocol: "ranex-delegated-provider",
    version: 1,
    taskId: "task-vector-01",
    endpoint: { scheme: "http", host: "127.0.0.1", port: metadata.port },
    capability,
    protocolFingerprint: fingerprint,
    provider: "openrouter",
    model: "example/model",
    allowedToolNames: ["alpha", "weather"],
    expiresAt: "2030-01-01T00:05:00Z",
    limits: { maxBootstrapBytes: 65536, maxConcurrency: 1, maxRequestBytes: 4194304, maxRequests: 8, maxResponseBytes: 16777216, timeoutSeconds: 120, ttlSeconds: 300 },
  }
  const actualEnv = readChildEnvironment(child.pid)
  return DelegatedProviderClient.fromBootstrap(
    parseDelegatedProviderBootstrap(bootstrap),
    { process: child, argv, env },
    captureForChild(argv, actualEnv, stdout, stderr),
  )
}

async function drain(stream: ReadableStream<Uint8Array>, capture: string[]) {
  const reader = stream.getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return
    capture.push(new TextDecoder().decode(chunk.value))
  }
}

function readChildEnvironment(pid: number) {
  try {
    return Object.fromEntries(readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0").filter(Boolean).map((entry) => {
      const index = entry.indexOf("=")
      return [entry.slice(0, index), entry.slice(index + 1)]
    }))
  } catch {
    return {}
  }
}
