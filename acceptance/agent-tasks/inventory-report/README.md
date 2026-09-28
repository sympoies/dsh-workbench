# Task: inventory report

Fixture: [sympoies/dsh-workbench-acceptance](https://github.com/sympoies/dsh-workbench-acceptance)
at its baseline `main`.

- `prompt-1.md` asks for an `inv report` subcommand with text and JSON output,
  a low-stock filter, tests, and README documentation, committed on a feature
  branch without pushing.
- `prompt-2.md`, sent after the TUI exits and resumes the same session, asks
  for delivery as a pull request with passing CI and signed commits.
- `verify.mjs CHECKOUT` runs the repository's own tests, then checks the exact
  text and JSON output, tie ordering, the low-stock filter, argument errors,
  unchanged `list` output, and the README. It passes on a reference
  implementation and fails on the baseline.

The Workbench agent never sees `verify.mjs`. Run it through
`node scripts/agent-acceptance.ts verify-pr --verifier` as described in
[agent delivery acceptance](../../../docs/agent-acceptance.md).
