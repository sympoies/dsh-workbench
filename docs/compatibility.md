# Compatibility and release identity

[`compatibility/workbench.json`](../compatibility/workbench.json) is the only
editable component pin set. It records the Workbench version and status, DSH,
runtime-kit, and TUI source identities, package identities, integrity values,
toolchains, target platforms, and validation gates. Release tooling and
installers must read this file and reject mismatches before activation. They
must not substitute a branch head, registry `latest`, or relaxed peer
dependency resolution for the recorded identities.

The current graph is **candidate**. Its DSH and TUI package integrity values
come from the npm registry at the pinned package versions. Git commit and tree
values identify the upstream source revisions; runtime-kit has no published npm
release at this revision, so its Git tree is its source integrity identity.
The contract records the upstream package version `0.0.0` for runtime-kit; that
is not a Workbench release version. These identities were checked on
2026-09-25, but no Web/TUI composition or cross-interface session handoff has
passed yet.

## Gate

`node scripts/contract.mjs check` validates structure and immutable pin shape.
`node scripts/contract.mjs require-accepted` is the activation gate: it fails
while the contract is a candidate. An accepted contract requires all three
components marked accepted and distinct public evidence links for runtime-kit,
TUI, Web, and cross-interface handoff on every declared target platform. A
local schema check alone does not
establish that upstream packages match the recorded hashes; the build and
installation workflows must verify those bytes when implemented.

The common runtime baseline is Node.js 24 or newer on the target platform
set recorded in the contract. A target platform is a planned test target while
the contract is a candidate; it becomes a supported platform only when its
release acceptance passes. Upstream package manager versions are recorded as
source-build facts, not an instruction to install floating dependencies.

## Workbench versions

Workbench uses its own SemVer release identity and tags `v<version>`. The
candidate target version in the contract is reserved for this tuple; it is not
a published release. A change to any component source URL, tag, commit, tree,
package name, version, integrity, runtime platform, or toolchain requires a new
Workbench version and tag. Product or artifact changes can also advance the
Workbench version while the component pins stay the same. New versions must
advance in SemVer order; release publication must reject an existing tag. CI
runs `contract.mjs compare` against `main` to enforce the contract relationship.
Changing acceptance from candidate to accepted for the *same* tuple keeps the
target version. Once accepted, a version's contract is immutable; a later
tuple or artifact change gets a new release, preserving prior artifacts.

Consumers may use `node scripts/contract.mjs print` to read the validated
contract as JSON. Future Web images, TUI packages, install receipts, docs, and
release metadata must derive their identity from that output. This repository
does not yet ship any of those artifacts.
