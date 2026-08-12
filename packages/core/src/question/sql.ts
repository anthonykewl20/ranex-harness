import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { QuestionV2 } from "../question"
import type { SessionV2 } from "../session"

export const QuestionRequestTable = sqliteTable("question_request", {
  id: text().$type<QuestionV2.ID>().primaryKey(),
  session_id: text().$type<SessionV2.ID>().notNull(),
  data: text({ mode: "json" }).$type<QuestionV2.Request>().notNull(),
  ...Timestamps,
})
