import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["RANEX_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["RANEX_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("RANEX_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  RANEX_AUTO_HEAP_SNAPSHOT: truthy("RANEX_AUTO_HEAP_SNAPSHOT"),
  RANEX_GIT_BASH_PATH: process.env["RANEX_GIT_BASH_PATH"],
  RANEX_CONFIG: process.env["RANEX_CONFIG"],
  RANEX_CONFIG_CONTENT: process.env["RANEX_CONFIG_CONTENT"],
  RANEX_DISABLE_AUTOUPDATE: truthy("RANEX_DISABLE_AUTOUPDATE"),
  RANEX_ALWAYS_NOTIFY_UPDATE: truthy("RANEX_ALWAYS_NOTIFY_UPDATE"),
  RANEX_DISABLE_PRUNE: truthy("RANEX_DISABLE_PRUNE"),
  RANEX_DISABLE_TERMINAL_TITLE: truthy("RANEX_DISABLE_TERMINAL_TITLE"),
  RANEX_SHOW_TTFD: truthy("RANEX_SHOW_TTFD"),
  RANEX_DISABLE_AUTOCOMPACT: truthy("RANEX_DISABLE_AUTOCOMPACT"),
  RANEX_DISABLE_MODELS_FETCH: truthy("RANEX_DISABLE_MODELS_FETCH"),
  RANEX_DISABLE_MOUSE: truthy("RANEX_DISABLE_MOUSE"),
  RANEX_FAKE_VCS: process.env["RANEX_FAKE_VCS"],
  RANEX_SERVER_PASSWORD: process.env["RANEX_SERVER_PASSWORD"],
  RANEX_SERVER_USERNAME: process.env["RANEX_SERVER_USERNAME"],
  RANEX_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("RANEX_DISABLE_FFF"),

  // Experimental
  RANEX_EXPERIMENTAL_FILEWATCHER: Config.boolean("RANEX_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("RANEX_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  RANEX_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("RANEX_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  RANEX_MODELS_URL: process.env["RANEX_MODELS_URL"],
  RANEX_MODELS_PATH: process.env["RANEX_MODELS_PATH"],
  RANEX_DB: process.env["RANEX_DB"],

  RANEX_WORKSPACE_ID: process.env["RANEX_WORKSPACE_ID"],
  RANEX_EXPERIMENTAL_WORKSPACES: enabledByExperimental("RANEX_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get RANEX_DISABLE_PROJECT_CONFIG() {
    return truthy("RANEX_DISABLE_PROJECT_CONFIG")
  },
  get RANEX_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("RANEX_EXPERIMENTAL_REFERENCES")
  },
  get RANEX_TUI_CONFIG() {
    return process.env["RANEX_TUI_CONFIG"]
  },
  get RANEX_CONFIG_DIR() {
    return process.env["RANEX_CONFIG_DIR"]
  },
  get RANEX_PURE() {
    return truthy("RANEX_PURE")
  },
  get RANEX_PERMISSION() {
    return process.env["RANEX_PERMISSION"]
  },
  get RANEX_PLUGIN_META_FILE() {
    return process.env["RANEX_PLUGIN_META_FILE"]
  },
  get RANEX_CLIENT() {
    return process.env["RANEX_CLIENT"] ?? "cli"
  },
}
