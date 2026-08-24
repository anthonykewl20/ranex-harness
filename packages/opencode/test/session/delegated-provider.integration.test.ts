import { describe, expect, test } from "bun:test"
import { spawnFakeBroker } from "./fixtures/delegated-fake-broker"

describe("delegated provider loopback boundary", () => {
  test("completes canonical handshake and bounded SSE without a provider key", async () => {
    const client = await spawnFakeBroker()
    await using _client = client

    const response = await client.chat({
      protocolFingerprint: client.protocolFingerprint,
      messages: [{ role: "user", content: "synthetic prompt" }],
    })
    expect(response.text).toContain("text-delta")
    expect(response.usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    expect(client.prohibitedChannelBytes(response.text)).toEqual([])
  })
})
