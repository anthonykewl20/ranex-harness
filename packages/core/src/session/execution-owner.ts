export * as ExecutionOwner from "./execution-owner"

const bootIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const bootID = await readBootId()
const startTime = await readStartTime(process.pid)

export const ownerID = `${process.pid}:${bootID ?? ""}:${startTime ?? ""}`

export function parsePid(owner: string): number | undefined {
  const pid = Number(owner.split(":")[0])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

export async function readBootId(): Promise<string | undefined> {
  try {
    const value = (await Bun.file("/proc/sys/kernel/random/boot_id").text()).trim()
    return bootIDPattern.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

export async function readStartTime(pid: number): Promise<number | undefined> {
  try {
    const stat = await Bun.file(`/proc/${pid}/stat`).text()
    const commEnd = stat.lastIndexOf(")")
    if (commEnd < 0) return undefined
    const value = Number(stat.slice(commEnd + 1).trim().split(/\s+/)[19])
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  } catch {
    return undefined
  }
}

export async function isLive(owner: string): Promise<boolean> {
  const fields = owner.split(":")
  if (fields.length !== 3) return true
  const pid = parsePid(owner)
  if (pid === undefined || !fields[1] || !bootIDPattern.test(fields[1])) return true
  const claimedStartTime = Number(fields[2])
  if (!Number.isSafeInteger(claimedStartTime) || claimedStartTime < 0) return true

  const currentBootID = await readBootId()
  if (currentBootID === undefined) return true
  if (currentBootID !== fields[1]) return false

  const currentStartTime = await readStartTime(pid)
  if (currentStartTime === undefined) return false
  return currentStartTime === claimedStartTime
}
