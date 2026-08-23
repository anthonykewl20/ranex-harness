const sentinels = {
  capability: "CAPABILITY_SENTINEL",
  endpoint: "ENDPOINT_SENTINEL",
  session: "SESSION_SENTINEL",
  prompt: "PROMPT_SENTINEL",
}

export function scanProhibitedChannels(value: unknown) {
  const serialized = JSON.stringify(value)
  return Object.values(sentinels).filter((sentinel) => serialized.includes(sentinel))
}

if (import.meta.main) {
  const input = await Bun.stdin.text()
  const leaks = scanProhibitedChannels(JSON.parse(input))
  process.exitCode = leaks.length === 0 ? 0 : 1
}
