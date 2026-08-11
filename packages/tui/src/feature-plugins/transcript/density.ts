import type { TuiPluginApi } from "@ranex/plugin/tui"

/**
 * CHAT-16 — density.
 *
 * claude-code #39913 asks for a compact display mode. #56423's complaint is
 * subtler and is the reason this persists rather than living in a signal: tool
 * output expansion was *"inconsistent across machines"*. A preference that does
 * not survive is a preference the operator re-sets forever.
 *
 * Density changes what is **shown**, never what is **recorded**. The projection
 * is identical in every mode; only rendering differs.
 */
export const DENSITIES = ["compact", "normal", "full"] as const
export type Density = (typeof DENSITIES)[number]

const KEY = "transcript_density"

export function isDensity(value: unknown): value is Density {
  return typeof value === "string" && (DENSITIES as readonly string[]).includes(value)
}

export function readDensity(api: TuiPluginApi): Density {
  const stored = api.kv.get(KEY, "normal" as string)
  // An unknown stored value falls back to `normal` rather than throwing or
  // picking the nearest — a corrupt preference must not make the app unusable.
  return isDensity(stored) ? stored : "normal"
}

export function cycleDensity(api: TuiPluginApi): Density {
  const next = DENSITIES[(DENSITIES.indexOf(readDensity(api)) + 1) % DENSITIES.length] ?? "normal"
  api.kv.set(KEY, next)
  return next
}

/**
 * Whether a kind is shown at all in this density.
 *
 * **A density may never hide a decision the operator has to make.** Permissions
 * and errors are shown in every mode, including `compact`: a setting that hid an
 * approval request would turn a preference into a governance failure.
 */
export function shows(density: Density, kind: string): boolean {
  if (kind === "permission" || kind === "error") return true
  if (density === "compact") return kind !== "reasoning"
  return true
}

/** Whether a collapsible entry starts open. Only `full` expands by default. */
export function startsOpen(density: Density): boolean {
  return density === "full"
}
