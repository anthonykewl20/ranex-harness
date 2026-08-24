import { chmodSync, closeSync, openSync, rmSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import {
  DelegatedProviderClient,
  loadDelegatedProviderBootstrap,
  PROTOCOL_FINGERPRINT,
} from "@/session/llm/delegated-provider"
import { spawnFakeBroker } from "./fixtures/delegated-fake-broker"

const fingerprint = "115c60229299f4769d01e88f4c4c758a0be6a9bbfd6090bb6ace9c2562f27ca2"

describe("session.llm-native.delegated-provider", () => {
  test("uses the pinned protocol fingerprint and consumes bootstrap metadata from FD3", async () => {
    expect(PROTOCOL_FINGERPRINT).toBe(fingerprint)

    const path = `/tmp/opencode/issue-106-bootstrap-${process.pid}-${Date.now()}.json`
    await Bun.write(path, JSON.stringify({
      protocol: "ranex-delegated-provider",
      version: 1,
      taskId: "task-vector-01",
      endpoint: { scheme: "http", host: "127.0.0.1", port: 43127 },
      capability: Buffer.alloc(32, 7).toString("base64url"),
      protocolFingerprint: fingerprint,
      provider: "openrouter",
      model: "example/model",
      allowedToolNames: ["alpha", "weather"],
      expiresAt: "2030-01-01T00:05:00Z",
      limits: { maxBootstrapBytes: 65536, maxConcurrency: 1, maxRequestBytes: 4194304, maxRequests: 8, maxResponseBytes: 16777216, timeoutSeconds: 120, ttlSeconds: 300 },
    }))
    try {
      chmodSync(path, 0o600)
      try { closeSync(3) } catch {}
      expect(openSync(path, "r")).toBe(3)
      const bootstrap = loadDelegatedProviderBootstrap(3)
    expect(bootstrap.protocolFingerprint).toBe(fingerprint)
    expect(bootstrap.capability).toHaveLength(32)
    expect(bootstrap.endpoint).toBe("http://127.0.0.1")
    } finally {
      rmSync(path, { force: true })
    }
  })

  test("compares fingerprints on handshake and chat, refusing mismatches before transport", async () => {
    const client = await spawnFakeBroker()
    await using _client = client

    await expect(client.handshake({ protocolFingerprint: fingerprint })).resolves.toMatchObject({
      protocolFingerprint: fingerprint,
    })
    await expect(
      client.handshake({ protocolFingerprint: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "unsupported_version", status: 400 })
    await expect(
      client.chat({ protocolFingerprint: "0".repeat(64), messages: [{ role: "user", content: "sentinel" }] }),
    ).rejects.toMatchObject({ code: "unsupported_version", status: 400 })
  })

  test("cancels before transport when the signal is already aborted", async () => {
    const client = await spawnFakeBroker()
    await using _client = client
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      throw new Error("unexpected transport")
    }) as unknown as typeof globalThis.fetch
    const abort = new AbortController()
    abort.abort()
    try {
      await expect(client.chat({ protocolFingerprint: fingerprint, messages: [], signal: abort.signal })).rejects.toMatchObject({ code: "client_cancelled", status: 499 })
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("cancels an in-flight lazy handshake and does not start SSE", async () => {
    const client = await spawnFakeBroker()
    await using _client = client
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
      })
    }) as unknown as typeof globalThis.fetch
    const abort = new AbortController()
    try {
      const pending = client.chat({ protocolFingerprint: fingerprint, messages: [], signal: abort.signal })
      await Promise.resolve()
      abort.abort()
      await expect(pending).rejects.toMatchObject({ code: "client_cancelled", status: 499 })
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("carries capability and session only in canonical handshake/chat fields", async () => {
    const client = await spawnFakeBroker()
    await using _client = client
    const handshake = await client.handshake({ protocolFingerprint: fingerprint })
    const request = client.canonicalChatRequest({
      protocolFingerprint: fingerprint,
      messages: [{ role: "user", content: "sentinel prompt" }],
    })

    expect(request.protocolFingerprint).toBe(fingerprint)
    expect(request.capability).toEqual(handshake.capability)
    expect(request.session).toBe(handshake.session)
    expect(JSON.stringify(request)).toContain("sentinel prompt")
    expect(client.prohibitedChannelBytes(request)).toEqual([])
  })
})
