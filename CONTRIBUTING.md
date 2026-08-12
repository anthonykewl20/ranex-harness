# Contributing to ranex-harness

This is a pre-release fork of the Ranex project; see the [README](./README.md).
It is developed alongside the Ranex kernel, a sibling Python repository that is
authoritative for architecture, ADRs, slices, and verdicts. External
contribution is not the primary model. If you are not the owner, open an issue
before any pull request.

## Developing the harness

Requires Bun 1.3 or newer. Install dependencies and start development from the
repository root:

```bash
bun install
bun dev
```

`bun dev` runs in `packages/ranex`. To run against another directory:

```bash
bun dev <directory>
```

Start the opt-in headless API server with `bun dev serve`. It listens on port
4096 by default; use `bun dev serve --port N` to choose another port.

Typecheck from the affected package, never from the repository root and never
with `tsc` directly:

```bash
cd packages/ranex
bun typecheck
```

Tests cannot run from the repository root; the root `test` script guards this.
Run tests from the relevant package directory.

After changing the public Protocol or Server `HttpApi`, regenerate clients by
running `bun run generate` from `packages/client`. Never edit
`src/generated` or `src/generated-effect` directly.

## Building a standalone executable

```bash
./packages/ranex/script/build.ts --single
./packages/ranex/dist/opencode-<platform>/bin/opencode
```

Replace `<platform>` with your platform, such as `darwin-arm64` or `linux-x64`.
The binary path still carries the upstream name for now.

## Pull requests

Open an issue first and explain the problem briefly in your own words. Do not
submit AI-generated walls of text.

PR titles use conventional commits: `type(scope): summary`. Valid types are
`feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. The scope is optional;
examples include `core`, `ranex`, `tui`, `llm`, and `sdk`.

## Style

Follow the repository rules and style in [AGENTS.md](./AGENTS.md).

## Debugging

Start an inspectable process with `bun run --inspect=ws://localhost:6499/ dev`.
If server breakpoints do not hit, try `bun dev spawn` because the usual command
runs the server in a worker thread.
