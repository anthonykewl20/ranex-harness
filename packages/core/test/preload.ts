import path from "path"

process.env.RANEX_DB = ":memory:"
process.env.RANEX_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.RANEX_DISABLE_MODELS_FETCH = "true"
