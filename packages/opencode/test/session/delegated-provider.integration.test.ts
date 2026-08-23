import { describe, expect, test } from "bun:test"
import { DelegatedProviderClient } from "@/session/llm/delegated-provider"

describe("delegated provider loopback boundary", () => {
  test("completes canonical handshake and bounded SSE without a provider key", async () => {
    const client = await DelegatedProviderClient.spawnBroker({
      broker: new URL("./fixtures/delegated-fake-broker.ts", import.meta.url),
      bootstrapFd: 3,
    })
    await using _client = client

    const response = await client.chat({
      protocolFingerprint: client.protocolFingerprint,
      messages: [{ role: "user", content: "synthetic prompt" }],
    })
    expect(response).toContain("text-delta")
    expect(client.prohibitedChannelBytes(response)).toEqual([])
  })
})
