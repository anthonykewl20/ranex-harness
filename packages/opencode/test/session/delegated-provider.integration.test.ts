import { rmSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { ERROR_CODES, parseDelegatedProviderBootstrap } from "@/session/llm/delegated-provider"
import { spawnFakeBroker } from "./fixtures/delegated-fake-broker"

const fingerprint = "115c60229299f4769d01e88f4c4c758a0be6a9bbfd6090bb6ace9c2562f27ca2"

function bootstrap(limits = { maxBootstrapBytes: 65536, maxConcurrency: 1, maxRequestBytes: 4194304, maxRequests: 8, maxResponseBytes: 16777216, timeoutSeconds: 120, ttlSeconds: 300 }) {
  return {
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
    limits,
  }
}

describe("delegated provider loopback boundary", () => {
  test("completes canonical handshake and bounded SSE without a provider key", async () => {
    const client = await spawnFakeBroker()
    await using _client = client

    const response = await client.chat({
      protocolFingerprint: client.protocolFingerprint,
      messages: [{ role: "user", content: "synthetic prompt" }],
    })
    expect(response.text).toContain("text-delta")
    expect(response.content).toBe("ok")
    expect(response.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    expect(client.prohibitedChannelBytes(response.text)).toEqual([])
  })

  test("executes frozen limit, outcome, and zero-upstream refusal vectors", async () => {
    const limits = bootstrap().limits
    for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
      for (const value of [0, limits[key] + 1]) {
        expect(() => parseDelegatedProviderBootstrap(bootstrap({ ...limits, [key]: value }))).toThrow()
      }
    }

    const mismatch = await spawnFakeBroker()
    await using _mismatch = mismatch
    await expect(mismatch.handshake({ protocolFingerprint: "0".repeat(64) })).rejects.toMatchObject({ code: "unsupported_version", status: 400 })

    const cancelled = await spawnFakeBroker()
    await using _cancelled = cancelled
    const abort = new AbortController()
    abort.abort()
    await expect(cancelled.chat({ protocolFingerprint: fingerprint, messages: [], signal: abort.signal })).rejects.toMatchObject({ code: "client_cancelled", status: 499 })

    for (const code of ERROR_CODES) {
      const client = await spawnFakeBroker({ chatError: code })
      await using _client = client
      await expect(client.chat({ protocolFingerprint: fingerprint, messages: [] })).rejects.toMatchObject({ code })
    }

    for (const code of ["tool_not_allowed", "invalid_request", "replay", "expired", "session_mismatch"] as const) {
      const reportPath = `/tmp/opencode/issue-106-g3-upstream-${process.pid}-${code}.txt`
      const client = await spawnFakeBroker({ chatError: code, upstreamReportPath: reportPath })
      await using _client = client
      try {
        await expect(client.chat({ protocolFingerprint: fingerprint, messages: [] })).rejects.toMatchObject({ code })
        expect((await Bun.file(reportPath).text()).trim()).toBe("0")
      } finally {
        rmSync(reportPath, { force: true })
      }
    }
  }, 30_000)
})
