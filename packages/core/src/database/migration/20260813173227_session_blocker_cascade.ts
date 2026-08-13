import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813173227_session_blocker_cascade",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DELETE FROM permission_request WHERE session_id NOT IN (SELECT id FROM session);`)
      yield* tx.run(`DELETE FROM question_request WHERE session_id NOT IN (SELECT id FROM session);`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_permission_request\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`data\` text NOT NULL,
          \`agent\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_request_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_permission_request\`(\`id\`, \`session_id\`, \`data\`, \`agent\`, \`time_created\`, \`time_updated\`) SELECT \`id\`, \`session_id\`, \`data\`, \`agent\`, \`time_created\`, \`time_updated\` FROM \`permission_request\`;`,
      )
      yield* tx.run(`DROP TABLE \`permission_request\`;`)
      yield* tx.run(`ALTER TABLE \`__new_permission_request\` RENAME TO \`permission_request\`;`)
      yield* tx.run(`
        CREATE TABLE \`__new_question_request\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`data\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_question_request_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_question_request\`(\`id\`, \`session_id\`, \`data\`, \`time_created\`, \`time_updated\`) SELECT \`id\`, \`session_id\`, \`data\`, \`time_created\`, \`time_updated\` FROM \`question_request\`;`,
      )
      yield* tx.run(`DROP TABLE \`question_request\`;`)
      yield* tx.run(`ALTER TABLE \`__new_question_request\` RENAME TO \`question_request\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
    })
  },
} satisfies DatabaseMigration.Migration
