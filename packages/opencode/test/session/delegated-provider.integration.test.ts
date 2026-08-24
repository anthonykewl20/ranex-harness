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
    expect(response).toContain("text-delta")
    expect(client.prohibitedChannelBytes(response)).toEqual([])
  })
})
