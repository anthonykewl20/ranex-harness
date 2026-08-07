import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

export const QuestionRequestTable = sqliteTable("question_request", {
  id: text().primaryKey(),
  session_id: text().notNull(),
  data: text().notNull(),
  ...Timestamps,
})
