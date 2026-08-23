import { describe, expect, test } from "bun:test"
import { DelegatedProviderClient } from "@/session/llm/delegated-provider"
import { scanProhibitedChannels } from "./fixtures/delegated-sentinel-runner"

describe("delegated provider sentinel E2E", () => {
  test("keeps canonical sentinel carriage out of prohibited channels and cleans up the child", async () => {
    const client = await DelegatedProviderClient.spawnBroker({
      broker: new URL("./fixtures/delegated-fake-broker.ts", import.meta.url),
      bootstrapFd: 3,
    })
    await using _client = client

    const response = await client.chat({
      protocolFingerprint: client.protocolFingerprint,
      messages: [{ role: "user", content: "PROMPT_SENTINEL" }],
    })
    expect(scanProhibitedChannels(client.prohibitedChannelSnapshot())).toEqual([])
    expect(response).toContain("text-delta")
    await expect(client.shutdown()).resolves.toBeUndefined()
    expect(client.childExited).toBe(true)
  })

  test("rejects seeded prohibited-channel sentinels", () => {
    expect(scanProhibitedChannels({ argv: "CAPABILITY_SENTINEL" })).toEqual(["CAPABILITY_SENTINEL"])
    expect(scanProhibitedChannels({ env: "ENDPOINT_SENTINEL" })).toEqual(["ENDPOINT_SENTINEL"])
    expect(scanProhibitedChannels({ file: "SESSION_SENTINEL" })).toEqual(["SESSION_SENTINEL"])
  })
})
