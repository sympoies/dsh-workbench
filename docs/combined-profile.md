# Combined candidate profile

The first Workbench candidate uses a separate `workbench` DSH profile. It
combines the pinned DSH source, the Workbench-patched TUI, and runtime-kit.
The Web plugin, TUI, and patched DSH peers must be installed **before** runtime-kit setup:
runtime-kit snapshots the managed profile manifest and treats later bundle
edits as drift.

The Workbench stager reads runtime-kit's manifest from the Git commit and
tree pinned in the Workbench contract. `<kit-git-repo>` must contain that
commit; its current branch and working files are not input to staging.

This is an isolated candidate assembly procedure, not a release installer or
an existing-home migration. Use fresh roots and the exact identities in
[`compatibility/workbench.json`](../compatibility/workbench.json). The runtime-kit
source and its `compatibility/dsh.json` must be authenticated against that
contract. Never use a current branch head or a stock DSH peer package in place
of the patched closure.

## Prepare the graph

1. Check out the contract's exact DSH commit into a disposable source tree.
   Authenticate the exact runtime-kit source, then apply its
   `native-execution-boundaries-v5` patch through
   `dsh-runtime-kit-manage-dsh-patch --action apply`. Run its `--action check`
   against that checkout and require `after: "patched"`.
2. Build both DSH faces from that patched source. Follow runtime-kit's
   [source build instructions](https://github.com/sympoies/dsh-runtime-kit/blob/main/docs/operations.md)
   for the clean and Host build; then build the client TypeScript project and
   client face with the source toolchain:

   ```sh
   node ./node_modules/typescript/bin/tsc -b tsconfig.client.json
   ./node_modules/.bin/tsdown --env.DSH_BUILD_FACE client
   ```

   The DSH source uses pnpm `11.7.0`;
   the Workbench profile uses pnpm `11.24.0`.
3. From the authenticated runtime-kit source, use its owner packer to create
   the reviewed patched DSH closure in an empty artifact directory:

   ```sh
   npm run --silent pack:compatibility-peers -- \
     --source-root <patched-dsh-root> \
     --artifact-root <empty-artifact-dir> \
     --registry-artifact-root <pinned-native-registry-archive-dir> \
     --channel pinned --patch-state patched \
     --pnpm-bin <absolute-pnpm-11.7.0-path> \
     --receipt <separate-peer-receipt.json>
   ```

   The runtime-kit packer checks the reviewed patch before and after packing
   and authenticates every archive against the fixed canonical digests in its
   contract. The Linux combined-profile CI also runs runtime-kit's independent
   peer stager against every archive before the Workbench stager; the owner
   stager currently uses Linux descriptor paths and cannot run on macOS. The
   receipt
   contains local paths and is not a release artifact.
   The registry input contains the five unmodified native-system 0.1.2 archives
   declared by the exact runtime-kit contract, downloaded with scripts disabled.
   All 84 archives are verified; Linux x64 stages 81 packages and reports the
   three incompatible optional native platforms as skipped. Workbench
   deterministically repacks the authenticated workspace archives before
   staging, so gzip metadata and tar member order cannot change the frozen
   file integrity between build hosts. The repack keeps non-manifest member
   bytes and every custom `package.json` map unchanged while canonicalizing
   manifest whitespace, root-field order, and the three standard name-to-version
   dependency maps. The release record separately
   pins each peer's order-preserving semantic digest. Registry
   archives keep their exact raw
   bytes and pinned SHA-512. Local-file overrides cover only the host-compatible
   set; nonhost native dependencies keep their exact registry versions and
   integrity in the frozen lockfile.

   `scripts/verify-combined-runtime.ts` also accepts an optional final absolute
   installed DSH CLI entry file. Use this argument with a frozen official CLI
   entry at `profiles/workbench/node_modules/@deepseek-ai/dsh/lib/bin.js` to
   prove the portable runtime boundary. Omitting it selects
   the prepared source CLI for the distinct source-assembly rehearsal. An invalid
   installed entry is refused before profile or runtime state is created.
4. Build the Workbench Web plugin with `pnpm web:build`, then pack it into a
   local archive with `pnpm --dir web pack --pack-destination
   <private-artifact-dir>`. The build checks the generated identity against
   this repository's contract. Download the exact TUI registry archive without
   running package scripts,
   for example with `npm pack <contract-tui-package>@<contract-tui-version>
   --ignore-scripts --pack-destination <private-artifact-dir>`. Stage a
   **new** profile under a fresh DSH home. Create its `profiles` directory,
   Download the exact official CLI archive the same way using the contract
   DSH package and version, then pass that same home to the stager and runtime-kit:

   ```sh
   install -d -m 0700 <absolute-dsh-home>/profiles
   node scripts/combined-profile.mjs <kit-git-repo> <separate-peer-receipt.json> <tui-archive.tgz> <web-archive.tgz> <official-cli-archive.tgz> <absolute-dsh-home>
   export DSH_HOME=<absolute-dsh-home>
   ```

   The command requires the runtime-kit patched receipt and checks each archive
   against both its receipt and the fixed canonical digest read from the
   contract-pinned Git object. It also checks the official CLI archive's package
   name, version, and SHA-512
   integrity before creating the profile. The official CLI is a direct profile
   dependency and must be launched from this profile, so stock API and UI owners
   resolve the same patched core modules as the Web/TUI plugins. A separate CLI
   host is a provenance input, not the accepted runtime entry.
   It also checks the TUI archive's SHA-512
   integrity against the Workbench contract before writing any profile files.
   It creates exactly `$DSH_HOME/profiles/workbench`, stages authenticated
   canonical package content in stable tarballs, and writes only relative
   `file:artifacts/...` references.
   Every host-compatible archive is a direct profile dependency as well as an
   override. This keeps bundle plugin owners and their scope consumers in one
   local module graph; an override alone does not prevent a missing plugin
   from falling back to the separately installed CLI host. All 84 archives are
   authenticated, while the three incompatible native leaves remain outside
   the Linux x64 dependencies and overrides. Runtime-kit's public peer ABI
   remains the same ten packages.
   It rejects a Web archive whose package name, Workbench version, or canonical
   artifact digest differs from the reviewed
   [`web-artifact.json`](../compatibility/web-artifact.json) record. That
   digest is outside the Web plugin's embedded contract identity, avoiding a
   build-hash cycle. The profile starts with the base, native Web, and
   patched TUI bundles and the Workbench Web plugin; runtime-kit is not yet installed.
5. Copy the reviewed
   [Linux profile lockfile](../compatibility/linux-profile-lock.yaml) into the
   fresh profile, then run pnpm `install --frozen-lockfile
   --strict-peer-dependencies --ignore-scripts`. Require the lockfile bytes to
   remain unchanged. Regenerating and deduplicating a lockfile is a separate
   release-version preparation step, not an installation step. When preparing
   a record, take the workspace digest from the staged `pnpm-workspace.yaml` and
   require pnpm to leave it unchanged: pnpm adds a `minimumReleaseAgeExclude`
   entry when a locked package is younger than its release-age policy.
   `node scripts/verify-profile-record.ts [--require-lock] <absolute-profile>`
   compares the staged workspace and lock with the reviewed artifact record. Runtime-kit
   setup continues to reject any later unrelated profile or lockfile mutation.
   Use runtime-kit's documented owner launcher to preview and apply `setup
   --profile workbench --package <exact-kit-package>`. Require `doctor
   --profile workbench` to report `healthy` with no advisories. The combined
   profile CI verifies this sequence against the isolated `$DSH_HOME` above,
   an exact package packed from the pinned runtime-kit source, and the
   runtime-kit's authenticated nils-cli binaries. Before setup, the matrix
   verifies that runtime-kit refuses an existing unmanaged
   `$DSH_HOME/AGENTS.md` without changing its bytes; the disposable fixture
   then removes that test file and continues with a clean home.
6. Launch the pinned DSH binary **through the same runtime-kit owner launcher**
   with `--profile workbench`. The compatible nils-cli set required by the
   pinned kit includes authenticated `agent-hook`, `agent-docs`, and adjacent
   `agent-session` binaries. The kit declaration governs their exact version
   and hashes.

The combined-profile CI also starts the activated `workbench` Web Host through
that launcher, opens its native UI in an authenticated Chromium, drives Bash
approval allow and reject, verifies command execution or nonexecution and
durable completed turns, and checks the loaded plugin's exact contract identity. The installed browser gate then runs the seven shared-session scenarios
against that same activated profile, including both handoff directions,
writer exclusion, host crash recovery, image continuation and a synthetic
copied Session V2 archive. Governed Bash and completed-turn assertions remain
distinct from ordinary Web startup. CI authenticates the official CLI archive
and installs it inside the activated Workbench profile alongside the patched
closure. Every runtime owner, terminal driver, and shared-session driver launches
that profile's `node_modules/@deepseek-ai/dsh/lib/bin.js`. A separately installed
host exists only for independent provenance and license inventory. Both graphs
pass strict peer installation and frozen-lockfile checks; the runtime has one
CLI/profile module graph. The patched source build supplies authenticated archive
inputs; its source CLI is not used for this portable boundary. These are candidate
gates until their exact frozen graph has a public passing receipt.

The installed TUI entry is owned by Workbench. Its source entry is
`scripts/launch-workbench-tui.ts`. Profile staging materializes this entry,
its implementation, and license under `workbench-tui/`, with relative paths
and SHA-256 digests in `receipt.json`; launching does not require this checkout.
The installed entry takes explicit absolute kit-package,
runtime-root, and installed CLI paths followed by `--` and application arguments.
It fixes the profile to `workbench` and supports exact-ID `--resume <id>` or
`--resume=<id>`. It projects that option into TUI's existing
`DSH_TUI_RESUME_SESSION` configuration before replacing itself with the original
runtime-kit launcher through Node's `execve`. It preserves the other arguments
and environment, including every policy input. It owns and clears inherited
`DSH_TUI_RESUME_SESSION` unless an explicit exact ID is supplied. Bare or duplicate
resume options, resume after `--`, and last-session shortcuts are refused.
The direct DSH/Web entry remains unchanged. Direct
`dsh --profile workbench --resume <id>` is not the TUI entry: the shared graph's
Web-only command parser rejects that option.

The installed terminal gate uses this TUI entry. The installed browser/handoff
gate requires separate `--dsh-bin` and `--tui-bin` paths for the Web/runtime-owner
and Workbench TUI entries. Both entries use the same activated profile and exact
installed CLI, package manifest, lockfile, session store, and runtime owner.
Installed runtime verification accepts only the normalized CLI entry under
`profiles/workbench/node_modules/@deepseek-ai/dsh/lib/bin.js` with the contract's
package name and version. It rejects another regular CLI before creating
verification state. Both installed wrappers use the packed runtime-kit owner.

Do not change `package.json`, its bundle order, or `pnpm-lock.yaml` after
runtime-kit setup. An update must stage a new graph and re-run the managed
operation against that complete generation. The staged profile, its pnpm lock,
and local artifact receipt remain candidate evidence until the release gate
verifies immutable source and binary identities, TUI behavior, Web/TUI handoff,
and every platform declared by that release. The first release declares Linux
x64. Native macOS arm64 with reduced finish-line capability is a later
feasibility scope under [#48](https://github.com/sympoies/dsh-workbench/issues/48).
The full OS-enforced arbitrary-descendant cleanup route remains under
[#47](https://github.com/sympoies/dsh-workbench/issues/47) and
[nils-cli #1800](https://github.com/sympoies/nils-cli/issues/1800). Neither
macOS route is implemented or accepted by this Linux candidate.
