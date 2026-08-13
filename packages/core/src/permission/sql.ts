import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { AgentV2 } from "../agent"
import { ProjectV2 } from "../project"
import { ProjectTable } from "../project/sql"
import type { SessionV2 } from "../session"
import { SessionTable } from "../session/sql"
import type { PermissionV2 } from "../permission"
import type { PermissionSaved } from "./saved"

export const PermissionRequestTable = sqliteTable("permission_request", {
  id: text().$type<PermissionV2.ID>().primaryKey(),
  session_id: text()
    .$type<SessionV2.ID>()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  data: text({ mode: "json" }).$type<PermissionV2.Request>().notNull(),
  agent: text().$type<AgentV2.ID>(),
  ...Timestamps,
})

export const PermissionTable = sqliteTable(
  "permission",
  {
    id: text().$type<PermissionSaved.ID>().primaryKey(),
    project_id: text()
      .$type<ProjectV2.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    action: text().notNull(),
    resource: text().notNull(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("permission_project_action_resource_idx").on(table.project_id, table.action, table.resource)],
)
