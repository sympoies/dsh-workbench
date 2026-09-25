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
values identify the upstream source revisions. The runtime-kit source now pins
the merged DSH 0.1.7 support from [PR #272](https://github.com/sympoies/dsh-runtime-kit/pull/272);
runtime-kit has no published npm release at this revision, so its Git tree is
its source integrity identity. The contract records the upstream package
version `0.0.0` for runtime-kit; that is not a Workbench release version.
These identities were checked on 2026-09-25. Runtime-kit compatibility and
managed-worktree recovery passed its owner CI; Web/TUI composition and
cross-interface session handoff remain candidate gates.

The TUI's `dsh-working-activity@0.4.0` dependency still declares peers for
older DSH client packages and React 18. The selected TUI uses React 19 and
declares support for DSH `0.1.7-rc.1`; unmodified npm and pnpm strict installs
reject the combined graph. The TUI contract therefore records the exact
working-activity and React versions for a Workbench-scoped peer correction.
`node scripts/tui-compat.mjs` renders pnpm overrides for only that package's
eight stale peer edges, while pinning the TUI's working-activity dependency and
the graph's React version. The corrected graph passed a strict frozen install in
an isolated probe, and a disposable TUI profile reached the terminal UI.
The Linux real-TTY acceptance additionally drove both an allowed-once and a
rejected Bash escalation through the pinned TUI, then verified distinct
Session V4 decisions, tool results, completed turns, and command execution or
non-execution after a strict final archive read. Those checks do not
yet establish the full TUI acceptance gate. The overrides do
not change the published package bytes or relax peer checks for any other
dependency; a future installer must include them in its frozen graph and
reject an unexpected working-activity version.

[`compatibility/tui-profile/pnpm-lock.yaml`](../compatibility/tui-profile/pnpm-lock.yaml)
is a reviewed, generated lockfile for the disposable TUI profile used by the
[handoff procedure](session-handoff.md). It freezes that profile's transitive
dependencies; it is not a second editable component version contract or an
accepted installer receipt. CI verifies a strict frozen install with it. A
candidate profile update must regenerate and review this lockfile against the
single component contract before the handoff proof is repeated.

## Gate

`node scripts/contract.mjs check` validates structure and immutable pin shape.
`node scripts/contract.mjs require-accepted` is the activation gate: it fails
while the contract is a candidate. An accepted contract requires all three
components marked accepted and distinct public evidence links for runtime-kit,
TUI, Web, and cross-interface handoff on every declared target platform. A
local schema check alone does not
establish that upstream packages match the recorded hashes; the build and
installation workflows must verify those bytes when implemented.
Schema 2 adds the Workbench pnpm pin and the TUI peer correction; the compare
gate reads the initial schema-1 candidate only as a previous release.

The current common runtime baseline is Node.js 24 or newer, derived from the
pinned runtime-kit's minimum, on the target platform set recorded in the
contract. A target platform is a planned test target while
the contract is a candidate; it becomes a supported platform only when its
release acceptance passes. Upstream package manager versions are recorded as
source-build facts. Workbench pins pnpm `11.24.0` for its own graph. The
generated pnpm settings explicitly exempt only the exact selected TUI release
from a local minimum-release-age policy, because a freshly published release
cannot otherwise pass that independent supply-chain gate; its package integrity
still comes from the contract and strict frozen installation remains required.

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
contract as JSON. The Web plugin now embeds a generated identity with a
SHA-256 digest of the parsed contract and reports the release and three
component pins. Its package build checks that identity against the contract.
This identifies a candidate build; it does not prove the actual installed
runtime-kit or TUI package matches. Future Web images, TUI packages, install
receipts, and release metadata must verify the installed graph and derive
their identity from the same contract before activation.
