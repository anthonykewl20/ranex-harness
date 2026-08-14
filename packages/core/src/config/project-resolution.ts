export * as ConfigProjectResolution from "./project-resolution"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export const defaults = { deadline_ms: 5_000 } as const

export class Info extends Schema.Class<Info>("ConfigV2.ProjectResolution")({
  deadline_ms: PositiveInt.pipe(Schema.optional).annotate({
    description:
      "Maximum time in milliseconds a caller waits for project and VCS resolution before returning a retryable timeout.",
  }),
}) {}

export function deadline(info?: Info) {
  return info?.deadline_ms ?? defaults.deadline_ms
}
