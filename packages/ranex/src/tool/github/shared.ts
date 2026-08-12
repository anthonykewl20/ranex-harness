import { ApiError, AuthMissing, RepoNotResolved } from "@/github/error"

export function githubErrorResult(error: unknown): { title: string; output: string } {
  if (error instanceof AuthMissing) {
    return {
      title: "GitHub auth required",
      output:
        "GITHUB_TOKEN environment variable is not set. Set it to a GitHub personal access token with repo and project scope.",
    }
  }
  if (error instanceof RepoNotResolved) {
    return {
      title: "Repository not resolved",
      output: error.message,
    }
  }
  if (error instanceof ApiError) {
    return {
      title: `GitHub API error${error.status ? ` (${error.status})` : ""}`,
      output: error.message,
    }
  }
  return {
    title: "GitHub error",
    output: error instanceof Error ? error.message : String(error),
  }
}
