import { expect, test } from "bun:test"
import { errorMessage } from "@/util/error"
import { Rpc } from "@/util/rpc"

test("rejects RPC calls with a useful serialized Error", async () => {
  const originalOnmessage = globalThis.onmessage
  const originalPostMessage = globalThis.postMessage
  const target: {
    postMessage: (data: string) => void
    onmessage: ((this: Worker, ev: MessageEvent<unknown>) => unknown) | null
  } = {
    postMessage(data) {
      void globalThis.onmessage?.call(undefined as never, new MessageEvent("message", { data }))
    },
    onmessage: null,
  }
  try {
    globalThis.postMessage = (data) => {
      target.onmessage?.call(undefined as never, new MessageEvent("message", { data }))
    }
    Rpc.listen({
      fail() {
        throw Object.assign(new Error("worker failed"), { code: "WORKER_FAILED" })
      },
    })
    const client = Rpc.client<{ fail: (input: undefined) => void }>(target)
    const error = await client.call("fail", undefined).then(
      () => new Error("expected RPC call to fail"),
      (error) => error,
    )
    expect(error).toMatchObject({
      name: "Error",
      message: "worker failed",
      code: "WORKER_FAILED",
    })
    expect(errorMessage(error)).toBe("worker failed")
  } finally {
    globalThis.onmessage = originalOnmessage
    globalThis.postMessage = originalPostMessage
  }
})
