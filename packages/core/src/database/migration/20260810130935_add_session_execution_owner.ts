import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810130935_add_session_execution_owner",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`execution_owner\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
