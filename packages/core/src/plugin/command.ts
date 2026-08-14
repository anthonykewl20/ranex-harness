export * as CommandPlugin from "./command"

import { define } from "./internal"
import { Effect } from "effect"
import { ProjectResolution } from "../project-resolution"
import PROMPT_INITIALIZE from "./command/initialize.txt"
import PROMPT_REVIEW from "./command/review.txt"

export const Plugin = define({
  id: "command",
  effect: Effect.fn(function* (ctx) {
    const resolution = yield* ProjectResolution.Service
    const ready = yield* resolution.awaitReady().pipe(Effect.orDie)
    yield* ctx.command.transform((draft) => {
      draft.update("init", (command) => {
        command.template = PROMPT_INITIALIZE.replace("${path}", ready.project.directory)
        command.description = "guided AGENTS.md setup"
      })
      draft.update("review", (command) => {
        command.template = PROMPT_REVIEW.replace("${path}", ready.project.directory)
        command.description = "review changes [commit|branch|pr], defaults to uncommitted"
        command.subtask = true
      })
    })
  }),
})
