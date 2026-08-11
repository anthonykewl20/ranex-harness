import type { TuiPlugin, TuiPluginModule } from "@ranex/plugin/tui"
import Board from "./board"
import HomeFooter from "./home/footer"
import HomeTips from "./home/tips"
import SidebarApproval from "./sidebar/approval"
import SidebarAttempts from "./sidebar/attempts"
import SidebarBudget from "./sidebar/budget"
import SidebarChildren from "./sidebar/children"
import SidebarFiles from "./sidebar/files"
import SidebarFooter from "./sidebar/footer"
import SidebarGates from "./sidebar/gates"
import SidebarLsp from "./sidebar/lsp"
import SidebarMcp from "./sidebar/mcp"
import SidebarSubject from "./sidebar/subject"
import SidebarTodo from "./sidebar/todo"
import SidebarVerdict from "./sidebar/verdict"
import DiffViewer from "./system/diff-viewer"
import Notifications from "./system/notifications"
import PluginManager from "./system/plugins"
import WhichKey from "./system/which-key"

export type BuiltinTuiPlugin = Omit<TuiPluginModule, "id"> & {
  id: string
  tui: TuiPlugin
  enabled?: boolean
}

export function createBuiltinPlugins(options: { experimentalEventSystem: boolean }): BuiltinTuiPlugin[] {
  return [
    HomeFooter,
    HomeTips,
    SidebarMcp,
    SidebarLsp,
    SidebarTodo,
    SidebarFiles,
    SidebarSubject,
    SidebarVerdict,
    SidebarGates,
    SidebarApproval,
    SidebarAttempts,
    SidebarBudget,
    SidebarChildren,
    SidebarFooter,
    Notifications,
    PluginManager,
    WhichKey,
    DiffViewer,
    Board,
  ]
}
