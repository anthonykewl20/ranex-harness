# ranex

The Ranex application package of the ranex-harness monorepo: the `ranex` CLI,
the interactive TUI, and the HTTP server surface. It composes the durable V2
session core from `@ranex/core` into the user-facing product.

- `bun dev` from this directory starts the live TUI.
- `bun typecheck` from here — never from the repo root, never `tsc` directly.
- Tests run from package directories; the repo root guards against root runs.

See the root [README.md](../../README.md) for harness architecture and status,
[AGENTS.md](./AGENTS.md) for module and Effect conventions plus the GitHub
tools, and [SECURITY.md](../../SECURITY.md) for the security posture.
