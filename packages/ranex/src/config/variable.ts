export * as ConfigVariable from "./variable"

import path from "path"
import os from "os"
import { Filesystem } from "@/util/filesystem"
import { InvalidError } from "@ranex/core/v1/config/error"

type ParseSource =
  | {
      type: "path"
      path: string
    }
  | {
      type: "virtual"
      source: string
      dir: string
    }

type SubstituteInput = ParseSource & {
  text: string
  missing?: "error" | "empty"
  env?: Record<string, string>
  /** Untrusted (project-repo) config: leave {env:} and {file:} tokens literal. */
  untrusted?: boolean
}

function source(input: ParseSource) {
  return input.type === "path" ? input.path : input.source
}

function dir(input: ParseSource) {
  return input.type === "path" ? path.dirname(input.path) : input.dir
}

/** Apply {env:VAR} and {file:path} substitutions to config text. */
export async function substitute(input: SubstituteInput) {
  // Untrusted config comes from a possibly hostile repo: expanding {env:} or
  // {file:} here would leak secrets and arbitrary files (readToken resolves
  // ~/ and absolute paths). Return the text untouched so tokens stay visible
  // and inert instead.
  if (input.untrusted) return input.text

  const text = input.text.replace(/\{env:([^}]+)\}/g, (_, varName) => {
    return (input.env?.[varName] ?? process.env[varName]) || ""
  })

  const fileMatches = Array.from(text.matchAll(/\{file:[^}]+\}/g))
  if (!fileMatches.length) return text

  let out = ""
  let cursor = 0

  for (const match of fileMatches) {
    const token = match[0]
    const index = match.index
    out += text.slice(cursor, index)

    const prefix = text.slice(text.lastIndexOf("\n", index - 1) + 1, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    out += JSON.stringify(await readToken(input, token)).slice(1, -1)
    cursor = index + token.length
  }

  out += text.slice(cursor)
  return out
}

async function readToken(input: SubstituteInput, token: string) {
  const missing = input.missing ?? "error"
  let filePath = token.replace(/^\{file:/, "").replace(/\}$/, "")
  if (filePath.startsWith("~/")) {
    filePath = path.join(os.homedir(), filePath.slice(2))
  }

  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(dir(input), filePath)
  return Filesystem.readText(resolvedPath)
    .catch((error: NodeJS.ErrnoException) => {
      if (missing === "empty") return ""

      const errMsg = `bad file reference: "${token}"`
      if (error.code === "ENOENT") {
        throw new InvalidError(
          {
            path: source(input),
            message: errMsg + ` ${resolvedPath} does not exist`,
          },
          { cause: error },
        )
      }
      throw new InvalidError({ path: source(input), message: errMsg }, { cause: error })
    })
    .then((content) => content.trim())
}
