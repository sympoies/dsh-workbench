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
4. Build the Workbench Web plugin with `pnpm web:build`, then pack it into a
   local archive with `pnpm --dir web pack --pack-destination
   <private-artifact-dir>`. The build checks the generated identity against
   this repository's contract. Download the exact TUI registry archive without
   running package scripts,
   for example with `npm pack <contract-tui-package>@<contract-tui-version>
   --ignore-scripts --pack-destination <private-artifact-dir>`. Stage a
   **new** profile under a fresh DSH home. Create its `profiles` directory,
   then pass that same home to the stager and runtime-kit:

   ```sh
   install -d -m 0700 <absolute-dsh-home>/profiles
   node scripts/combined-profile.mjs <kit-git-repo> <separate-peer-receipt.json> <tui-archive.tgz> <web-archive.tgz> <absolute-dsh-home>
   export DSH_HOME=<absolute-dsh-home>
   ```

   The command requires the runtime-kit patched receipt and checks each archive
   against both its receipt and the fixed canonical digest read from the
   contract-pinned Git object. It also checks the TUI archive's SHA-512
   integrity against the Workbench contract before writing any profile files.
   It creates exactly `$DSH_HOME/profiles/workbench`, copies the verified bytes
   into the profile, and writes only relative `file:artifacts/...` references.
   It rejects a Web archive whose package name, Workbench version, or canonical
   artifact digest differs from the reviewed
   [`web-artifact.json`](../compatibility/web-artifact.json) record. That
   digest is outside the Web plugin's embedded contract identity, avoiding a
   build-hash cycle. The profile starts with the base, native Web, and
   patched TUI bundles and the Workbench Web plugin; runtime-kit is not yet installed.
5. In that profile, run pnpm `install --strict-peer-dependencies --ignore-scripts`
   and then `install --frozen-lockfile --strict-peer-dependencies --ignore-scripts`.
   Use runtime-kit's documented owner launcher to preview and apply `setup
   --profile workbench --package <exact-kit-package>`. Require `doctor
   --profile workbench` to report `healthy` with no advisories. The combined
   profile CI verifies this sequence against the isolated `$DSH_HOME` above,
   an exact package packed from the pinned runtime-kit source, and the
   runtime-kit's authenticated nils-cli binaries.
6. Launch the pinned DSH binary **through the same runtime-kit owner launcher**
   with `--profile workbench`. The compatible nils-cli set required by the
   pinned kit includes authenticated `agent-hook`, `agent-docs`, and adjacent
   `agent-session` binaries. The kit declaration governs their exact version
   and hashes.

The combined-profile CI also starts the activated `workbench` Web Host through
that launcher, opens its native UI in an authenticated Chromium, completes a
mock turn, and checks the loaded plugin's exact contract identity. This is a
single-profile Web startup proof; the full Web/TUI handoff acceptance still
uses separate profiles and governed Bash remains a distinct release gate.

Do not change `package.json`, its bundle order, or `pnpm-lock.yaml` after
runtime-kit setup. An update must stage a new graph and re-run the managed
operation against that complete generation. The staged profile, its pnpm lock,
and local artifact receipt remain candidate evidence until the release gate
verifies immutable source and binary identities, TUI behavior, Web/TUI handoff,
and both target platforms.
