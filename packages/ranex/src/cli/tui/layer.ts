import { run as runTui, type TuiInput } from "@ranex/tui"
import { Global } from "@ranex/core/global"
import { AppNodeBuilder } from "@ranex/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
