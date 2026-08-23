import { describe, expect, test } from "bun:test"
import {
  DelegatedProviderClient,
  loadDelegatedProviderBootstrap,
  PROTOCOL_FINGERPRINT,
} from "@/session/llm/delegated-provider"

const fingerprint = "115c60229299f4769d01e88f4c4c758a0be6a9bbfd6090bb6ace9c2562f27ca2"

describe("session.llm-native.delegated-provider", () => {
  test("uses the pinned protocol fingerprint and consumes bootstrap metadata from FD3", async () => {
    expect(PROTOCOL_FINGERPRINT).toBe(fingerprint)

    const bootstrap = await loadDelegatedProviderBootstrap(3)
    expect(bootstrap.protocolFingerprint).toBe(fingerprint)
    expect(bootstrap.capability).toHaveLength(32)
    expect(bootstrap.endpoint).toBe("http://127.0.0.1")
  })

  test("compares fingerprints on handshake and chat, refusing mismatches before transport", async () => {
    const client = await DelegatedProviderClient.fromFd3(3)

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

  test("carries capability and session only in canonical handshake/chat fields", async () => {
    const client = await DelegatedProviderClient.fromFd3(3)
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
