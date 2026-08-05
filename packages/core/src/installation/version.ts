declare global {
  const RANEX_VERSION: string
  const RANEX_CHANNEL: string
}

export const InstallationVersion = typeof RANEX_VERSION === "string" ? RANEX_VERSION : "local"
export const InstallationChannel = typeof RANEX_CHANNEL === "string" ? RANEX_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
