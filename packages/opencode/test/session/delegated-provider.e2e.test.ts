import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import { scanProhibitedChannels } from "./fixtures/delegated-sentinel-runner"
import { spawnFakeBroker } from "./fixtures/delegated-fake-broker"

describe("delegated provider sentinel E2E", () => {
  test("keeps canonical sentinel carriage out of prohibited channels and cleans up the child", async () => {
    const client = await spawnFakeBroker()
    await using _client = client
    const observedFiles: string[] = []
    const observedOutput: string[] = []
    const originalWrite = Bun.write as unknown as (path: string, data: any) => Promise<number>
    const originalLog = console.log
    const originalError = console.error
    const originalWriteFileSync = fs.writeFileSync
    Object.defineProperty(Bun, "write", { value: (path: string, data: any) => {
      observedFiles.push(String(path))
      return originalWrite(path, data)
    } })
    console.log = (...args) => observedOutput.push(args.map(String).join(" "))
    console.error = (...args) => observedOutput.push(args.map(String).join(" "))
    Object.defineProperty(fs, "writeFileSync", { value: (path: string, data: unknown, ...args: unknown[]) => {
      observedFiles.push(String(path), String(data))
      return originalWriteFileSync(path, data as never, ...(args as never[]))
    } })

    try {
      const response = await client.chat({
        protocolFingerprint: client.protocolFingerprint,
        messages: [{ role: "user", content: "PROMPT_SENTINEL" }],
      })
      client.capture.files.push(...observedFiles)
      client.capture.stdout.push(...observedOutput)
      client.capture.stderr.push(...observedOutput)
      client.capture.logs.push(...observedOutput)
      // responseArtifacts and nonCanonical remain empty: this SUT's production client performs no such writes.
      expect(scanProhibitedChannels(client.prohibitedChannelSnapshot(), client.prohibitedChannelValues())).toEqual([])
      for (const needle of client.prohibitedChannelValues()) {
        expect(scanProhibitedChannels({ scratch: needle }, client.prohibitedChannelValues())).toContain(needle)
      }
      expect(response).toContain("text-delta")
    } finally {
      Object.defineProperty(Bun, "write", { value: originalWrite })
      Object.defineProperty(fs, "writeFileSync", { value: originalWriteFileSync })
      console.log = originalLog
      console.error = originalError
    }
    await expect(client.shutdown()).resolves.toBeUndefined()
    expect(client.childExited).toBe(true)
  })

  test("rejects seeded prohibited-channel sentinels", () => {
    expect(scanProhibitedChannels({ argv: "CAPABILITY_SENTINEL" })).toEqual(["CAPABILITY_SENTINEL"])
    expect(scanProhibitedChannels({ env: "ENDPOINT_SENTINEL" })).toEqual(["ENDPOINT_SENTINEL"])
    expect(scanProhibitedChannels({ file: "SESSION_SENTINEL" })).toEqual(["SESSION_SENTINEL"])
  })
})
