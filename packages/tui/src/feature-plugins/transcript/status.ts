import type { SessionStatus } from "@ranex/sdk/v2"

/**
 * CHAT-12 — the status row.
 *
 * **The live state is spelled.** claude-code #70000 is a screen reader told
 * nothing about whether a response is generating or complete, because the only
 * signal was a spinner. A spinner may accompany these words; it may never
 * replace them.
 *
 * Retry is its own state rather than a flavour of busy. A turn that is being
 * retried after a provider failure is not the same as one running normally, and
 * collapsing them is how "silent fallback" complaints start (ux-research.md §3).
 */
export function statusLabel(status: SessionStatus | undefined): string {
  if (!status) return "idle"
  switch (status.type) {
    case "busy":
      return "responding"
    case "retry":
      // The attempt number is the part an operator acts on: one retry is noise,
      // three is a provider problem they need to know about.
      return `retrying (${status.attempt})`
    case "idle":
      return "idle"
  }
}

/**
 * Fields drop by declared priority when the row will not fit, and never overlap.
 *
 * The live state is last to go, because it is the only field that answers "is
 * anything happening right now".
 */
export function fitStatus(fields: readonly string[], width: number): string {
  const separator = "  "
  const out: string[] = []
  let used = 0
  // Walk from the end: the live state sits last and is dropped last.
  for (let i = fields.length - 1; i >= 0; i--) {
    const field = fields[i]
    if (!field) continue
    const cost = field.length + (out.length > 0 ? separator.length : 0)
    if (used + cost > width) continue
    used += cost
    out.unshift(field)
  }
  return out.join(separator)
}
