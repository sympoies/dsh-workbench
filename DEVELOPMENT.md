# Development

This repository is being initialized. The
[roadmap](https://github.com/sympoies/dsh-workbench/issues/10) owns the order
for the version contract, DSH Web and TUI ports, session handoff, and portable
release.

Use exact source tags or commits and keep a candidate graph separate from an
accepted release. Test Web and TUI against the same DSH session store and
workspace identity before claiming cross-interface resume.

TypeScript is the default for product source, substantive scripts, and tests.
Node 24.3.0 or later runs the erasable TypeScript directly without an
experimental warning. The `.mjs` files in `scripts/` are thin CLI entrypoints:
`contract.mjs` delegates to `src/contract.ts`, `tui-compat.mjs` delegates to
`src/tui-compat.ts`, `web-metadata.mjs` delegates to `src/web-metadata.ts`, and
`combined-profile.mjs` delegates to `src/combined-profile.ts`.
Keep new CLI wrappers equally thin, with their logic in typechecked TypeScript.
Install the exact development toolchain with
`pnpm install --frozen-lockfile --strict-peer-dependencies`, then run `pnpm typecheck` and
`pnpm test`. The root lockfile pins development tools; the separate
[compatibility contract](compatibility/workbench.json) pins the DSH product
graph. Generated files and `node_modules/` are not published.

For the Web plugin, run `pnpm web:metadata:check` and `pnpm web:build` before
`pnpm typecheck`; its generated `web/lib/` is ignored. The metadata check
ensures the Web package version, DSH catalog, and generated Client identity
match the contract. The package build runs this check before bundling. See the
[Web port notes](docs/web-port.md) for the current acceptance boundary.
On Linux with util-linux `script` and `zstdcat`, run the native browser
acceptance with a Chromium executable and an installed DSH executable at the
exact contract version:

```sh
pnpm test:web:browser --dsh-bin /path/to/pinned/dsh --browser-bin /path/to/chromium
```

The script builds and packs the Web plugin, installs Web and patched TUI
profiles in a disposable DSH home, and runs four sessions against authenticated
local mock LLM servers. It creates and renames a TUI session, stops TUI, then
checks its exact ID, title, prompt, and answer in native Web before and after a
Web Host restart. While Web still holds a session writer, it checks that TUI
refuses an exact-ID resume without changing the archive. After Web stops, TUI
resumes that Web session, completes another turn, and Web reads the continuation
on restart. It also checks distinct Web IDs, isolated histories, a
pending turn, tool approval and rejection, a provider error, and Web Host
restart recovery. The fixture, profiles, and mock endpoints are removed
afterward. Package installation is isolated from caller credentials, and
Chromium sandboxing remains enabled. This does not establish the full
cross-interface handoff, image composition, or release acceptance gates.

Run `node --test tests/contract.test.ts tests/tui-compat.test.ts` and
`node scripts/contract.mjs check`
when changing the [compatibility contract](compatibility/workbench.json). A
change to any component source or package identity requires a new Workbench
release version; CI compares the contract with `main`. See the
[contract guide](docs/compatibility.md) for acceptance and release rules.
Run `node --test tests/tui-graph.test.ts` with the pinned pnpm version when
changing the TUI compatibility patch or peer correction. It reproduces the
uncorrected strict peer failure, then resolves and installs the exact DSH/TUI
graph with the reviewed patch and peer correction.
On Linux or macOS with `zstdcat`, run the real terminal approval
acceptance with an installed executable of the exact DSH contract version:

```sh
pnpm test:tui:terminal --dsh-bin /path/to/pinned/dsh
```

The combined-profile CI runs this acceptance twice on Linux x64 and macOS
arm64 after its authenticated graph setup and doctor check: first with a
frozen TUI-only profile, then with the installed `workbench` profile. The
terminal test uses a native pseudoterminal through the development-only
`node-pty` package. To repeat the combined profile check against an isolated
installation, use the runtime-kit launcher wrapper and pass
`--installed-dsh-home /absolute/path/to/dsh-home` plus
`--runtime-env-file /absolute/path/to/terminal-environment.json`; the runtime
verification script marks only its disposable DSH home and emits the matching
environment file for this use.
The acceptance drives Allow once and
Reject through two real TTY sessions against an authenticated local mock, and
checks the final Session V4 archive, approval, tool result, completed turn,
and whether the allowed or rejected command actually ran. It also creates a
72-turn conversation beyond the TUI's initial rendered-row cap, exits,
resumes its exact ID, submits another turn, and checks its unique title and
the exact `/resume` session count through a headless terminal screen. It also
renames a session, exits, resumes that exact ID, and completes another turn
while checking the durable user-title event. It then exercises the patched
stopped-session title writer and resumes the same ID again. The default test
uses a disposable DSH home; the installed-home option must point to a
disposable installation because the scenarios create sessions there. No
provider credential is needed. This gate does not claim cross-interface handoff.

For durable design or compatibility outcomes, update the current owner first,
then use `devlog new` to append one evidence-backed entry. Run `devlog check`
before delivery. The log's format and privacy rules are in
[docs/devlog/README.md](docs/devlog/README.md).

Before sending source for review, run `bash scripts/check-publication.sh` and
review the [publication checklist](docs/publication.md). A generated release
candidate must also pass each generated artifact tree to that script with
`--artifact PATH`, followed by human review.
