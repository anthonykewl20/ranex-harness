const sentinels = {
  capability: "CAPABILITY_SENTINEL",
  endpoint: "ENDPOINT_SENTINEL",
  session: "SESSION_SENTINEL",
  prompt: "PROMPT_SENTINEL",
}

export function scanProhibitedChannels(value: unknown, realValues: readonly string[] = []) {
  const haystack = rawChannelText(value)
  return [...Object.values(sentinels), ...realValues].filter((needle, index, needles) => needles.indexOf(needle) === index && needle !== "" && haystack.includes(needle))
}

function rawChannelText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(rawChannelText).join("\n")
  if (value && typeof value === "object") return Object.entries(value).map(([key, child]) => `${key}: ${rawChannelText(child)}`).join("\n")
  return String(value)
}

if (import.meta.main) {
  const parsed = JSON.parse(await Bun.stdin.text()) as { channels?: unknown; realValues?: unknown }
  const realValues = Array.isArray(parsed.realValues) ? parsed.realValues.filter((value): value is string => typeof value === "string") : []
  const leaks = scanProhibitedChannels(parsed.channels ?? parsed, realValues)
  process.exitCode = leaks.length === 0 ? 0 : 1
}
