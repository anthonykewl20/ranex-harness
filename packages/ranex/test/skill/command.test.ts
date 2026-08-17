import { describe, expect } from "bun:test"
import { LayerNode } from "@ranex/core/effect/layer-node"
import { Effect } from "effect"
import path from "path"
import { Command } from "../../src/command"
import { Skill } from "../../src/skill"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Skill.node, Command.node])))

describe("skill commands", () => {
  it.instance(
    "Command.list() rebuilds with skills added after initial load via skill refresh",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const skill = yield* Skill.Service
        const commands = yield* Command.Service

        yield* Effect.promise(() =>
          Bun.write(
            path.join(directory, ".opencode", "skill", "existing", "SKILL.md"),
            `---
name: existing
description: Existing skill.
---

# Existing
`,
          ),
        )
        expect((yield* commands.list()).map((command) => command.name)).toContain("existing")

        yield* Effect.promise(() =>
          Bun.write(
            path.join(directory, ".opencode", "skill", "added", "SKILL.md"),
            `---
name: added
description: Added skill.
---

# Added
`,
          ),
        )
        // Command state still holds the skills frozen at init.
        expect((yield* commands.list()).map((command) => command.name)).not.toContain("added")

        yield* skill.refresh()
        const names = (yield* commands.list()).map((command) => command.name)
        expect(names).toContain("added")
        expect((yield* commands.get("added"))?.source).toBe("skill")
      }),
    { git: true },
  )
})
