import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812114223_session_retry",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`retry_attempt\` integer;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`retry_next_attempt_at\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
