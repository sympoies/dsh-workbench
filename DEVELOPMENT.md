# Development

This repository is being initialized. The
[roadmap](https://github.com/sympoies/dsh-workbench/issues/10) owns the order
for the version contract, DSH Web and TUI ports, session handoff, and portable
release.

Use exact source tags or commits and keep a candidate graph separate from an
accepted release. Test Web and TUI against the same DSH session store and
workspace identity before claiming cross-interface resume.

TypeScript is the default for source and tests. Node 24.3.0 or later runs the
erasable TypeScript directly without an experimental warning; the two `.mjs`
files in `scripts/` preserve stable CLI
entry points. Install the exact development toolchain with
`pnpm install --frozen-lockfile --ignore-scripts`, then run `pnpm typecheck` and
`pnpm test`. The root lockfile pins development tools; the separate
[compatibility contract](compatibility/workbench.json) pins the DSH product
graph. Generated files and `node_modules/` are not published.

Run `node --test tests/contract.test.ts tests/tui-compat.test.ts` and
`node scripts/contract.mjs check`
when changing the [compatibility contract](compatibility/workbench.json). A
change to any component source or package identity requires a new Workbench
release version; CI compares the contract with `main`. See the
[contract guide](docs/compatibility.md) for acceptance and release rules.
Run `node --test tests/tui-graph.test.ts` with the pinned pnpm version when
changing the TUI peer correction. It reproduces the uncorrected strict peer
failure, then resolves and installs the exact DSH/TUI graph with the correction.

For durable design or compatibility outcomes, update the current owner first,
then use `devlog new` to append one evidence-backed entry. Run `devlog check`
before delivery. The log's format and privacy rules are in
[docs/devlog/README.md](docs/devlog/README.md).

Before sending source for review, run `bash scripts/check-publication.sh` and
review the [publication checklist](docs/publication.md). A generated release
candidate must also pass each generated artifact tree to that script with
`--artifact PATH`, followed by human review.
