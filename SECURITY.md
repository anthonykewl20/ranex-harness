# Security

## Threat model

ranex-harness is an AI agent runtime providing tools for shell execution, file
operations, and web access.

## No sandbox

The harness does **not** sandbox the agent. The permission system is a UX
feature that prompts before commands, edits, and writes; it is not security
isolation. For true isolation, run the harness in a container or virtual
machine.

Process-level confinement of the bound command is the Ranex kernel's ADR-006
program (SLICE-017+), not yet in production. Until then, treat the agent's
environment as trusted-by-necessity, not enforced-trusted.

## Server mode

Server mode is opt-in. When enabled, set `RANEX_SERVER_PASSWORD` to require
HTTP Basic Auth. Without it, the server runs unauthenticated with a warning.
Securing the server is the operator's responsibility, and functionality it
intentionally provides is not a vulnerability.

## Out of scope

| Category                        | Rationale                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| **Server access when opted-in** | If you enable server mode, API access is expected behavior              |
| **Sandbox escapes**             | The permission system is not a sandbox                                  |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior**         | External MCP servers you configure are outside our trust boundary       |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector    |

## Reporting security issues

Report vulnerabilities through the repository's
[GitHub Security Advisory](https://github.com/anthonykewl20/ranex-harness/security/advisories/new)
page.
