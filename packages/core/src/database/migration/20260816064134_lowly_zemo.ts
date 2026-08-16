import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260816064134_lowly_zemo",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`retry_cumulative_delay_ms\` integer;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`retry_window_started_at\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
