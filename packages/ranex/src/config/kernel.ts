export * as ConfigKernel from "./kernel"

import { Schema } from "effect"
import { isRecord } from "@/util/record"
import { ConfigParse } from "./parse"

export const Info = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({
    description:
      "Absolute path to the ranex-kernel repository used by the kernel_run and kernel_verdict bridge tools. Must resolve outside the session worktree and the harness repository.",
  }),
}).annotate({
  identifier: "ConfigKernel",
  description: "Kernel bridge configuration for the kernel_run/kernel_verdict tools",
})
export type Info = typeof Info.Type

/**
 * Extract and validate the ranex-local `kernel` section from a raw parsed
 * config document. Returns undefined when no kernel section is present so the
 * caller can proceed with the core schema alone. A malformed section throws a
 * config error naming the source file, exactly like any other config key.
 */
export function parse(input: unknown, source: string): Info | undefined {
  if (!isRecord(input) || !("kernel" in input)) return undefined
  const value = input.kernel
  if (value === null) return undefined
  return ConfigParse.schema(Info, value, source)
}

/**
 * Copy of `input` without the `kernel` key. The core ConfigV1.Info parse
 * rejects unrecognized top-level keys, so the ranex-local section is stripped
 * before that parse and reattached to the decoded value by the caller.
 */
export function strip(input: unknown): unknown {
  if (!isRecord(input) || !("kernel" in input)) return input
  const next = { ...input }
  delete next.kernel
  return next
}
