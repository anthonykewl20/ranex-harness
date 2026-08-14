export * as ManagedOutput from "./managed-output"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { statics } from "./schema"

export const ID = Schema.String.check(Schema.isStartsWith("out_")).pipe(
  Schema.brand("ManagedOutput.ID"),
  statics((schema) => ({ create: () => schema.make("out_" + ascending()) })),
)
export type ID = typeof ID.Type
