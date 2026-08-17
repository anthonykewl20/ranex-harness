import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260817120000_permission_request_scope",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`permission_request\` ADD \`scope\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
