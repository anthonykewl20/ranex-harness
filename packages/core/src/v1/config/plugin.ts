export * as ConfigPluginV1 from "./plugin"

import { Schema } from "effect"
import { InvalidError } from "./error"

export const Options = Schema.Record(Schema.String, Schema.Unknown)
export type Options = Schema.Schema.Type<typeof Options>

export const Spec = Schema.Union([Schema.String, Schema.mutable(Schema.Tuple([Schema.String, Options]))])
export type Spec = Schema.Schema.Type<typeof Spec>

export function assertDisabled(entries: readonly unknown[] | undefined, source: string, key: "plugin" | "plugins") {
  if (!entries?.length) return
  throw new InvalidError({
    path: source,
    issues: [
      {
        path: [key],
        message: `External plugins are disabled: ${entries.map(pluginIdentifier).join(", ")}`,
      },
    ],
  })
}

function pluginIdentifier(entry: unknown) {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry)) return String(entry[0])
  if (typeof entry === "object" && entry !== null && "package" in entry) return String(entry.package)
  return "unknown"
}
