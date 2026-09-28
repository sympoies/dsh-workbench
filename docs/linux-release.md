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
The frozen [Linux profile lockfile](../compatibility/linux-profile-lock.yaml)
is also checked against that Git commit. CI installs from this exact lockfile
without resolving or deduplicating a new dependency graph.
Before creating that lockfile, Workbench verifies the runtime-kit peer-pack
receipt and canonical package digests, then repacks workspace and Web archives
in a deterministic tar/gzip form. Non-manifest member bytes remain unchanged;
the package manifest canonicalization sorts only root fields and the standard
`dependencies`, `devDependencies`, and `peerDependencies` name-to-version maps;
all other nested object order is retained. The
source-bound Linux artifact record pins an additional order-preserving semantic
digest for every non-registry peer and the Web archive; the legacy runtime-kit
canonical digest remains the separate compatibility identity.
Registry archives retain their pinned raw
integrities. This prevents build-host tar metadata from changing the file
integrities recorded by the frozen lockfile.
The bundled compatibility contract, Web record, patch, and installer source
must match that same commit before the verifier uses the archived contract to
select runtime-kit provenance. The only generated installer file is the fixed
module-type package manifest.
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

## Linux owner installation

`scripts/linux-install.mjs` has separate `plan` and `apply` actions. Run it from
the source revision named by the release manifest, after checking the external
archive and manifest SHA-256 values. The source checkout, runtime-kit source
checkout, archive, and owner inputs must be controlled by the installing user.
The input is an owner-private JSON file with exactly these fields:

```json
{
  "schemaVersion": "dsh-workbench.linux-install-input.v1",
  "archivePath": "/absolute/path/to/release.tar.gz",
  "archiveSha256": "<64 lowercase hex characters from the external release receipt>",
  "manifestSha256": "<64 lowercase hex characters from the external release receipt>",
  "runtimeKitRepo": "/absolute/path/to/pinned/runtime-kit/source",
  "pnpmExecutable": "/absolute/path/to/owner-reviewed/pnpm.cjs",
  "pnpmSha256": "<64 lowercase hex characters of that exact executable>",
  "pnpmPackageRoot": "/absolute/path/to/owner-reviewed/pnpm-package",
  "pnpmPackageSha256": "<64 lowercase hex characters of the complete pnpm package tree>",
  "installRoot": "/absolute/path/to/new/private/install",
  "ownerEnvironmentFile": "/absolute/path/to/private/owner-environment.json"
}
```

The owner environment file is mode 0600, single-link, and contains only
explicit network settings and secret-file references. Each referenced secret
file is also owner-private. No secret value belongs in the install input,
receipt, release archive, or tracked source. The initial schema is:

```json
{
  "schemaVersion": "dsh-workbench.owner-environment.v1",
  "environment": { "DEEPSEEK_BASE_URL": "https://example.invalid/v1" },
  "secretFiles": { "DEEPSEEK_API_KEY": "/absolute/private/key-file" }
}
```

`HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` are the other supported plain
environment keys. Omit unused keys and references. The launchers discard
ambient values for these keys and read the owner file at launch, so rotation
does not require changing the installed release. An empty secret reference
map does not inherit a caller's API key.
The pnpm package is a trusted owner input: plan binds the canonical entrypoint,
its SHA-256, and the complete package tree digest. Apply rechecks these bytes
before invoking pnpm through the current Node binary. The current Node must
meet the contract baseline, and the package must be the reviewed pnpm version
in the contract. A matching version string printed by an arbitrary PATH
command is not sufficient.

Run `node scripts/linux-install.mjs plan /absolute/private/input.json`, review
the returned target and digests, then pass its exact `planDigest` to
`node scripts/linux-install.mjs apply /absolute/private/input.json <planDigest>`.
Planning writes nothing. Apply requires a fresh install root, rechecks the
input and archive, extracts and verifies the complete source-bound payload,
requires its own clean checkout to match the manifest's builder commit/tree,
performs a strict frozen profile installation, probes Linux finish-line
support, and requires digest-bound runtime-kit setup and a healthy doctor.
Failure removes only the newly created root. The private
`installed-unit-receipt.json` records immutable identities, probe results,
the approved plan and owner-configuration digests, and launcher paths;
`productAccepted: false` means that installation alone is
not a product acceptance verdict. Keep the receipt outside public logs and
review it before owner activation.

`bin/workbench-web` and `bin/workbench-tui` are the installed launchers. Both
use the same private DSH home and runtime-kit owner; the TUI launcher accepts
an explicit `--resume <session-id>` through the Workbench TUI entry. Launch
from the intended canonical Git workspace. A live session owner prevents
takeover. After a crash, the pinned Linux host must prove the old owner died,
clean up its work, rotate authority, and invalidate old validation evidence
before the other interface resumes. A pending Bash request is never
implicitly approved by recovery.

Install a newer or previous accepted version into a separate fresh root and
verify it before switching an owner-controlled service entry. Do not replace
the active root in place. Preserve the session home and its backup as a
separate owner operation; this installer creates a new empty home and does not
migrate user sessions. Stop the old owner and follow the session-copy and
rollback acceptance procedure before changing a production service target.

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
