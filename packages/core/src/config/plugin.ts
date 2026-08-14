export * as ConfigPlugin from "./plugin"

import { Schema } from "effect"
import { ConfigPluginV1 } from "../v1/config/plugin"

export class Entry extends Schema.Class<Entry>("ConfigV2.Plugin.Entry")({
  package: Schema.String,
  options: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}) {}

export const Plugin = Schema.Union([Schema.String, Entry])
export type Plugin = typeof Plugin.Type

export const Plugins = Plugin.pipe(Schema.Array)

export function assertDisabled(entries: readonly Plugin[] | undefined, source: string) {
  ConfigPluginV1.assertDisabled(entries, source, "plugins")
}
