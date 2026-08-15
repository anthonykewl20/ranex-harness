export * as Wildcard from "./wildcard"

export function match(input: string, pattern: string, opts?: { caseInsensitive?: boolean }) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  // Matching defaults to case-insensitive, matching the lowercase action
  // vocabulary everywhere. Security-sensitive resource rules narrow this via
  // opts: on POSIX, `allow` patterns match casing strictly so `allow
  // Secrets/*` cannot widen to `secrets/x`, while deny/ask rules stay broad
  // to prevent casing bypass; on win32 everything stays case-insensitive
  // (audit F-08).
  const caseInsensitive = opts?.caseInsensitive ?? true
  return new RegExp("^" + escaped + "$", caseInsensitive ? "si" : "s").test(normalized)
}
