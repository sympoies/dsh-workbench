# Linux release envelope

The Linux x64 release payload uses one derived
`dsh-workbench.linux-release.v1` manifest. The manifest is not another editable
component contract: it binds the exact accepted
[`compatibility/workbench.json`](../compatibility/workbench.json) bytes, the
generated graph digest, the producing Workbench source commit/tree, and every
payload file. The published release receipt must provide the raw SHA-256 of
`release-manifest.json` from outside the archive. A consumer must authenticate
that digest before trusting any field inside the manifest.

Verification requires an already extracted, owner-controlled root with mode
0700 and no symbolic-link parent. Its contents must remain isolated throughout
verification and installation. The later installer must consume that same
private snapshot; it must not reopen an untrusted download directory after the
check or accept concurrent writes by another process with the same UID. The
envelope verifier cannot make an ordinary directory immutable by itself.

`verifyLinuxReleaseEnvelope` checks the external digest, the complete sorted
file index, regular-file modes and sizes, SHA-256 of every indexed file, and
absence of unindexed files or symlinks. It then requires the included contract
to be accepted for Linux x64, compares the immutable graph identity, and binds
the declared Web archive digest and nils archive/tool identities to the
reviewed Web record and the pinned runtime-kit compatibility record. The
required archive set contains the exact contract-derived DSH and TUI package
paths, the release-derived Web package path, and a peer-closure archive; the
frozen profile package, workspace file, and lockfile must also be present. This
presence check does not authenticate archive contents or prove that the peer
closure is complete. The builder and installer perform those later checks. The
verifier must come from an independently authenticated source. A bundled copy
under `installer/` cannot verify its own integrity before it executes. The
external receipt's manifest digest authenticates the file index, but it does
not authenticate code that is loaded from the same unverified payload. All
release asset roots and paths in the manifest are relative; host
paths, account settings, credentials, session logs, and deployment topology do
not belong in the payload.

This envelope check is only the first installation gate. The builder must
authenticate and include the exact official DSH/TUI/Web archives, patched peer
closure, packed runtime-kit, frozen initial profile, nils release, notices and
sanitized production license inventories. The installer must independently
verify archive content identities, accept explicit private owner inputs,
perform a no-write plan and exact apply, install into fresh roots, run the
authoritative Linux host probe and runtime-kit setup/doctor, and issue a
private installed-unit receipt. CI must retain and install the same archive
bytes intended for publication. None of those steps is supplied by the
envelope verifier alone; it cannot assert an installed or released product.

The Linux candidate builder is `node scripts/linux-release.mjs
/absolute/private/build-input.json`. Its private input file has exactly these
absolute paths: `frozenProfile`, `runtimeKitRepo`, `runtimeKitPackage`,
`nilsArchive`, `profileLicenseInventory`, `cliLicenseInventory`, `outputRoot`,
and `outputArchive`. Both outputs must be new. The frozen profile is the
pre-setup, strictly installed profile, including its lockfile but excluding
`node_modules`. The runtime-kit package must be built from the contract-pinned
source checkout. The two inventories come from the installed production
profile and CLI host. Neither private input file nor local receipt belongs in
the release asset.

The builder requires a clean Workbench source checkout and the pinned
runtime-kit Git tree. It rebuilds runtime-kit from an isolated archive of that
tree and compares the canonical package contents with the supplied package.
The resulting source-build proof is included and indexed in the candidate.
The reviewed [`linux-artifacts.json`](../compatibility/linux-artifacts.json)
binds this release version to the runtime-kit package's canonical digest and
the frozen workspace and lockfile raw digests. Changing any of those identities
requires a new Workbench release version. The content verifier resolves this
record and profile source files from the Git commit/tree named by the
externally authenticated release manifest, instead of trusting the bundled
proof or a mutable working tree alone.
It assembles the closed profile file set, kit, nils binaries,
notices, and license inventories; then it runs the independently loaded
envelope and content checks on the new private output before archiving it. The
content check compares all 83 peer packages with the pinned runtime-kit
compatibility record, verifies the exact profile dependencies and peer-closure
bundle, checks official DSH/TUI SHA-512 identities and the reviewed Web
canonical digest, and compares the seven nils executables with the pinned
release archive. The JSON printed by the builder contains the external
manifest and archive SHA-256 values for a candidate receipt. Human publication
review still checks the source-to-bundle proof and all generated artifacts.

The builder and content checker do not install or accept a product. The
installer must independently use the authenticated archive bytes, verify the
external archive and manifest digests before consuming any bundled code, and
retain an owner-private receipt for the exact installed snapshot.

`scripts/linux-release-archive.mjs` authenticates the archive's external
SHA-256 before extracting a bounded regular-file ustar payload into a new
private root, then runs the detached manifest and content checks. The Linux CI
profile job extracts these same archive bytes and repeats frozen installation,
runtime-kit setup/doctor, Linux host probe, and installed Web/TUI handoff from
that extracted snapshot. CI candidate artifacts are still subject to the
publication audit; the archive and binary contents cannot pass the text-only
publication scanner by themselves.

The first publication still requires the complete
[human source, artifact, license and receipt audit](publication.md). Native
reduced macOS remains a later [#48](https://github.com/sympoies/dsh-workbench/issues/48)
lane after the Linux release and installation are confirmed. Full-authority
macOS remains separate under [#47](https://github.com/sympoies/dsh-workbench/issues/47)
and [nils-cli #1800](https://github.com/sympoies/nils-cli/issues/1800).
