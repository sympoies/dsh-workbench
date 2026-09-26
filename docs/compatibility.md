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
values identify the upstream source revisions. The runtime-kit source pins
the merged DSH 0.1.7 support from [PR #272](https://github.com/sympoies/dsh-runtime-kit/pull/272),
the authenticated patched peer closure from
[PR #274](https://github.com/sympoies/dsh-runtime-kit/pull/274), and the typed
finish-line denial diagnostics from
[PR #277](https://github.com/sympoies/dsh-runtime-kit/pull/277);
runtime-kit has no published npm release at this revision, so its Git tree is
its source integrity identity. The contract records the upstream package
version `0.0.0` for runtime-kit; that is not a Workbench release version.
These identities were checked on 2026-09-26. Runtime-kit compatibility and
managed-worktree recovery passed its owner CI; Web/TUI composition and
cross-interface session handoff remain candidate gates.

The [combined candidate profile procedure](combined-profile.md) stages the
patched DSH workspace dependency closure and TUI before runtime-kit setup.
The isolated Linux x64 graph passed strict and frozen pnpm installation,
runtime-kit `doctor` with `healthy` status, and real-terminal TUI startup.
This is composition evidence; it does not accept the tuple or establish a
portable release artifact.

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
non-execution after a strict final archive read. A second scenario created 72
turns beyond the TUI's 120-row initial render cap, exited, resumed the exact
session ID, completed another turn in the same archive, and confirmed both the
exact fixture session count and the long session's unique title in `/resume`.
The terminal assertion reconstructs the screen
from ANSI updates; searching the output byte stream cannot verify a changed
count because the TUI may emit only the changed digit. These checks do not yet
establish the full TUI acceptance gate. The overrides do
not relax peer checks for any other
dependency; a future installer must include them in its frozen graph and
reject an unexpected working-activity version.

Workbench `v0.1.0-rc.3` adds an exact
[`dsh-TUI 0.11.0` patch](../compatibility/patches/tui-rename.patch) for
[#24](https://github.com/sympoies/dsh-workbench/issues/24). Live `/rename`
now calls DSH's session-title service, which records the normalized title
with `messageSeqs: []` and `source.kind: user` and supersedes automatic
title generation. The persisted-session picker writes the same user-title
payload. The patch path and SHA-256 digest are part of the single contract;
the frozen profile lock records pnpm's patch hash. A real-terminal regression
proved manual rename, exact-ID restart, and another completed turn against
the patched profile. It also exercised the stopped-session title writer and
another exact-ID restart. The native Web browser acceptance now opens a
TUI-renamed Session V4 archive under the same ID and verifies its title,
prompt, and answer before and after a Web Host restart. The broader
cross-interface gate remains
under [#7](https://github.com/sympoies/dsh-workbench/issues/7).

Workbench `v0.1.0-rc.4` narrows the first release's acceptance targets to
Linux x64 and macOS arm64. Linux arm64 and macOS x64 may be evaluated for a
later Workbench version. This target change does not promote the graph from
candidate status or alter any of the three component pins.

Workbench `v0.1.0-rc.5` pins runtime-kit's merged patched-peer commit and
stages the combined profile at `$DSH_HOME/profiles/workbench` from the owner
receipt. Linux x64 and macOS arm64 have passed strict frozen installation,
digest-bound runtime-kit setup, healthy doctor, and a composed DSH/TUI config
smoke. The same two-platform CI separately exercised the pinned TUI profile
in a real PTY: approval allow/reject, tool results, 72-turn history,
exact-ID resume, and rename survived exit and restart. This proves TUI
behavior on both targets but does not yet exercise a real TTY on the combined
`workbench` profile or complete the Web/TUI handoff gate. Workbench
`v0.1.0-rc.6` adds the Workbench-built native Web plugin archive and checks its
package name, version, and canonical artifact SHA-256 against the reviewed
[`web-artifact.json`](../compatibility/web-artifact.json) record before adding
the official Web bundle and plugin to the same profile. The combined Web/TUI
graph must still pass hosted CI.
The publication comparison treats the reviewed Web artifact digest as part of
the release identity, including the first addition of the record. A changed
digest requires a higher Workbench release version.
Workbench `v0.1.0-rc.7` pins runtime-kit's typed nils host-denial diagnostics
and records the resulting Web plugin identity and artifact digest. This
diagnostic change does not provide the missing macOS finish-line backend or
accept the candidate graph.

[`compatibility/tui-profile/pnpm-lock.yaml`](../compatibility/tui-profile/pnpm-lock.yaml)
is a reviewed, generated lockfile for the disposable TUI profile used by the
[handoff procedure](session-handoff.md). It freezes that profile's transitive
dependencies and the exact compatibility patch; it is not a second editable
component version contract or an
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
Schema 3 adds the TUI patch identity; the compare gate reads schema 1 and 2
candidates only as previous releases.

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
package name, version, integrity, compatibility patch, runtime platform, or
toolchain requires a new
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
