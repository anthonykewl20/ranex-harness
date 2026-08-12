import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812160000_clear_legacy_execution_owner",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `UPDATE session SET execution_owner=NULL WHERE execution_owner IS NOT NULL AND execution_owner NOT LIKE '%:%:%'`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
