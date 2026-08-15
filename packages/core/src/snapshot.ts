export * as Snapshot from "./snapshot"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "./config"
import { File } from "./file"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { Global } from "./global"
import { Location } from "./location"
import { ProjectResolution } from "./project-resolution"
import { AbsolutePath, RelativePath } from "./schema"
import { Hash } from "./util/hash"

export const ID = Schema.String.check(
  // Snapshot IDs are git tree object IDs; hex-only so option-shaped values
  // cannot flow into git argv (audit F-06).
  Schema.isPattern(/^[0-9a-f]{4,64}$/),
).pipe(Schema.brand("Snapshot.ID"))
export type ID = typeof ID.Type

export class Error extends Schema.TaggedErrorClass<Error>()("Snapshot.Error", {
  operation: Schema.Literals(["capture", "files", "diff", "preview", "restore"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface CompareInput {
  readonly from: ID
  readonly to: ID
}

export interface DiffInput extends CompareInput {
  readonly context?: number
  readonly paths?: readonly RelativePath[]
}

export interface RestoreInput {
  /** Paths are relative to the project root. */
  readonly files: ReadonlyMap<RelativePath, ID>
}

export interface PreviewInput extends RestoreInput {
  readonly context?: number
}

export interface Interface {
  /**
   * Capture the current Location-scoped filesystem state as a content-addressed
   * tree. Returns `undefined` when snapshots are disabled, unsupported, or the
   * best-effort capture fails.
   */
  readonly capture: () => Effect.Effect<ID | undefined>

  /**
   * List project-relative paths changed between two captured trees without
   * loading file contents or generating patches.
   */
  readonly files: (input: CompareInput) => Effect.Effect<readonly RelativePath[], Error>

  /**
   * Generate structured per-file diffs between two captured trees. `context`
   * controls unchanged lines around each unified diff hunk.
   */
  readonly diff: (input: DiffInput) => Effect.Effect<readonly File.Diff[], Error>

  /**
   * Preview the filesystem result of a selective restore without modifying the
   * worktree. Each project-relative path maps to the tree it would be restored
   * from.
   */
  readonly preview: (input: PreviewInput) => Effect.Effect<readonly File.Diff[], Error>

  /**
   * Restore selected project-relative paths from their associated trees. A path
   * absent from its selected tree is removed; paths outside the map are untouched.
   */
  readonly restore: (input: RestoreInput) => Effect.Effect<void, Error>

  /**
   * Replace the snapshot index with a captured tree and check out all its entries.
   * Files absent from the tree remain untouched. Prefer selective `restore` when
   * only known paths should change.
   */
  readonly checkout: (snapshot: ID) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Snapshot") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const resolution = yield* ProjectResolution.Service

    const state = Effect.fnUntraced(function* (operation: Error["operation"]) {
      const ready = yield* resolution.awaitReady().pipe(Effect.mapError((cause) => failure(operation, cause)))
      const entries = yield* config.entries()
      const worktree = ready.repository
        ? AbsolutePath.make(yield* fs.realPath(ready.repository.worktree).pipe(Effect.orDie))
        : ready.project.directory
      return {
        source: ready.repository,
        project: ready.project,
        worktree,
        gitDirectory: AbsolutePath.make(
          path.join(global.data, "snapshot", ready.project.id, Hash.fast(worktree)),
        ),
        snapshots: Config.latest(entries, "snapshots") !== false,
      }
    })

    const scope = Effect.fnUntraced(function* (current: Effect.Success<ReturnType<typeof state>>) {
      const relative = path.relative(current.worktree, location.directory)
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* new Error({ operation: "capture", message: "Location is outside the project" })
      return RelativePath.make(relative.replaceAll("\\", "/") || ".")
    })

    const repository = Effect.fnUntraced(function* (
      current: Effect.Success<ReturnType<typeof state>>,
      operation: Error["operation"],
    ) {
      if (!current.source)
        return yield* new Error({ operation, message: "Project is not a Git repository" })
      if (yield* fs.existsSafe(path.join(current.gitDirectory, "HEAD")))
        return new Git.Repository({
          worktree: current.worktree,
          gitDirectory: current.gitDirectory,
          commonDirectory: current.gitDirectory,
        })
      return yield* git.repo
        .create({
          worktree: current.worktree,
          gitDirectory: current.gitDirectory,
          seed: current.source,
        })
        .pipe(Effect.mapError((cause) => failure(operation, cause)))
    })

    const capture = Effect.fn("Snapshot.capture")(function* () {
      return yield* Effect.gen(function* () {
        const current = yield* state("capture")
        if (!current.snapshots || current.project.vcs?.type !== "git") return undefined
        const repo = yield* repository(current, "capture")
        return ID.make(
          yield* git.tree.capture({
            repository: repo,
            scopes: [yield* scope(current)],
            ignores: current.source,
            maximumUntrackedFileBytes: 2 * 1024 * 1024,
          }),
        )
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("failed to capture snapshot", { cause }).pipe(Effect.as(undefined))),
      )
    })

    const compare = Effect.fnUntraced(function* (operation: "files" | "diff", input: CompareInput) {
      const current = yield* state(operation)
      return {
        current,
        repository: yield* repository(current, operation),
        scope: yield* scope(current),
        from: treeID(input.from),
        to: treeID(input.to),
      }
    })

    const files = Effect.fn("Snapshot.files")(function* (input: CompareInput) {
      const comparison = yield* compare("files", input)
      const files = (yield* git.tree.files(comparison).pipe(Effect.mapError((cause) => failure("files", cause)))).filter(
        (file) =>
          comparison.scope === "." || file === comparison.scope || file.startsWith(`${comparison.scope}/`),
      )
      if (!comparison.current.source) return files
      const ignored = yield* git.index
        .ignored({ repository: comparison.current.source, paths: files })
        .pipe(Effect.mapError((cause) => failure("files", cause)))
      return files.filter((file) => !ignored.has(file))
    })

    const diff = Effect.fn("Snapshot.diff")(function* (input: DiffInput) {
      const comparison = yield* compare("diff", input)
      const files = (yield* git.tree.files(comparison).pipe(Effect.mapError((cause) => failure("diff", cause)))).filter(
        (file) =>
          comparison.scope === "." || file === comparison.scope || file.startsWith(`${comparison.scope}/`),
      )
      const ignored = comparison.current.source
        ? yield* git.index
            .ignored({ repository: comparison.current.source, paths: files })
            .pipe(Effect.mapError((cause) => failure("diff", cause)))
        : new Set<RelativePath>()
      return yield* git.tree
        .diff({
          ...comparison,
          context: input.context,
          paths: (input.paths ?? files).filter((file) => !ignored.has(file)),
        })
        .pipe(Effect.mapError((cause) => failure("diff", cause)))
    })

    const plan = Effect.fnUntraced(function* (
      current: Effect.Success<ReturnType<typeof state>>,
      operation: "preview" | "restore",
      input: RestoreInput,
    ) {
      const files = new Map<RelativePath, Git.TreeID>()
      for (const [file, snapshot] of input.files) {
        const absolute = path.resolve(current.worktree, file)
        if (!FSUtil.contains(current.worktree, absolute))
          return yield* new Error({ operation, message: `Path escapes the project: ${file}` })
        files.set(file, treeID(snapshot))
      }
      return files
    })

    const preview = Effect.fn("Snapshot.preview")(function* (input: PreviewInput) {
      const current = yield* state("preview")
      if (!current.snapshots || current.project.vcs?.type !== "git")
        return yield* new Error({ operation: "preview", message: "Snapshots are disabled" })
      const repo = yield* repository(current, "preview")
      const files = yield* plan(current, "preview", input)
      const tree = yield* git.tree
        .capture({
          repository: repo,
          scopes: Array.from(files.keys()),
          ignores: current.source,
          maximumUntrackedFileBytes: 2 * 1024 * 1024,
        })
        .pipe(Effect.mapError((cause) => failure("preview", cause)))
      return yield* git.tree
        .preview({
          repository: repo,
          current: tree,
          files,
          context: input.context,
        })
        .pipe(Effect.mapError((cause) => failure("preview", cause)))
    })

    const restore = Effect.fn("Snapshot.restore")(function* (input: RestoreInput) {
      const current = yield* state("restore")
      if (!current.snapshots || current.project.vcs?.type !== "git")
        return yield* new Error({ operation: "restore", message: "Snapshots are disabled" })
      const repo = yield* repository(current, "restore")
      yield* git.tree
        .restore({ repository: repo, files: yield* plan(current, "restore", input) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    const checkout = Effect.fn("Snapshot.checkout")(function* (snapshot: ID) {
      const current = yield* state("restore")
      const repo = yield* repository(current, "restore")
      yield* git.tree
        .checkout({ repository: repo, tree: treeID(snapshot) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    return Service.of({ capture, files, diff, preview, restore, checkout })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Config.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, FSUtil.node, Git.node, Global.node, Location.node, ProjectResolution.node],
})

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    capture: () => Effect.succeed(undefined),
    files: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
  }),
)

function failure(operation: Error["operation"], cause: unknown) {
  if (cause instanceof Error && cause.operation === operation) return cause
  return new Error({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
    cause,
  })
}

/**
 * Re-brand without re-validating: the git argv boundary performs the typed
 * validation (audit F-06).
 */
function treeID(id: ID) {
  return id as unknown as Git.TreeID
}

/** Legacy persisted session diff shape. */
export type LegacyFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}
