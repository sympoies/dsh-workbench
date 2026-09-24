# AGENTS.md

## Scope

This repository owns the portable DSH Workbench product: one reviewed
compatibility contract for DeepSeek Harness, dsh-TUI, and dsh-runtime-kit,
the official-Web-based workbench extension, a TUI distribution surface,
portable installation, and acceptance evidence.

## Boundaries

- Keep host-specific paths, account settings, credentials, endpoints, session
  logs, and deployment topology out of tracked source and release artifacts.
- Do not import the history of any private predecessor. Review individual files
  before reusing their content.
- Keep Agent Console and other terminal hosts as consumers, not dependencies.
- Preserve upstream DSH conversation, session, tool, and approval semantics;
  propose generic lifecycle changes to the owning upstream.
- Treat a version combination as a candidate until both interfaces and session
  handoff pass the repository's acceptance gates. Accepted installs use exact
  immutable revisions from one contract.

## Development

- Write repository content and issue/PR records in English.
- Record durable compatibility and ownership decisions in
  [docs/devlog/README.md](docs/devlog/README.md) using the `devlog` CLI.
- Keep the canonical current contract or runbook up to date before adding a
  historical devlog entry.
- Build new source on non-default branches and deliver it through review.
