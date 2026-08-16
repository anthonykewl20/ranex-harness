import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260816064239_low_old_lace",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_blocker\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`assistant_message_id\` text,
          \`call_id\` text,
          \`aggregate_seq\` integer NOT NULL,
          \`actor\` text,
          \`resolution\` text,
          \`time_created\` integer NOT NULL,
          \`time_resolved\` integer,
          CONSTRAINT \`fk_session_blocker_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_blocker_session_active_idx\` ON \`session_blocker\` (\`session_id\`,\`time_resolved\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
