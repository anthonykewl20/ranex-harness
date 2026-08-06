import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { dispatchTrigger } from "../../src/plugin/index"

const systemHook = "experimental.chat.system.transform"

describe("plugin.trigger", () => {
  test("runs synchronous hooks without crashing", async () => {
    const output = { system: [] as string[] }
    const hooks = [
      {
        [systemHook]: (_input: unknown, current: typeof output) => {
          current.system.unshift("sync")
        },
      } as unknown as Hooks,
    ]

    await dispatchTrigger(hooks, systemHook, {}, output)

    expect(output.system).toEqual(["sync"])
  })

  test("awaits asynchronous hooks", async () => {
    const output = { system: [] as string[] }
    const hooks: Hooks[] = [
      {
        [systemHook]: async (_input, current) => {
          await Bun.sleep(1)
          current.system.unshift("async")
        },
      },
    ]

    await dispatchTrigger(hooks, systemHook, {}, output)

    expect(output.system).toEqual(["async"])
  })
})
