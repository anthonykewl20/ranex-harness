import { describe, expect } from "bun:test"
import { Config } from "@ranex/core/config"
import { ConfigProviderFailover, MAX_CHAIN_LENGTH } from "@ranex/core/config/provider-failover"
import { Effect, Layer, Option, Schema } from "effect"
import { testEffect } from "./lib/effect"

describe("provider failover config", () => {
  const decode = Schema.decodeUnknownOption(Config.Info, { errors: "all", onExcessProperty: "ignore" })

  testEffect(Layer.empty).effect("accepts model chains and rejects malformed model references", () =>
    Effect.sync(() => {
      const valid = decode({ provider_failover: { chain: ["primary/model", "backup/model/name"], on_watchdog: true } })
      expect(Option.isSome(valid)).toBe(true)
      if (Option.isSome(valid))
        expect(valid.value.provider_failover).toEqual(
          new ConfigProviderFailover.Info({ chain: ["primary/model", "backup/model/name"], on_watchdog: true }),
        )
      for (const chain of [
        ["model"],
        ["/model"],
        ["provider/"],
        Array.from({ length: MAX_CHAIN_LENGTH + 1 }, () => "backup/model"),
      ])
        expect(Option.isNone(decode({ provider_failover: { chain } }))).toBe(true)
    }),
  )
})
