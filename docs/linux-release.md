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

The first publication still requires the complete
[human source, artifact, license and receipt audit](publication.md). Native
reduced macOS remains a later [#48](https://github.com/sympoies/dsh-workbench/issues/48)
lane after the Linux release and installation are confirmed. Full-authority
macOS remains separate under [#47](https://github.com/sympoies/dsh-workbench/issues/47)
and [nils-cli #1800](https://github.com/sympoies/nils-cli/issues/1800).
