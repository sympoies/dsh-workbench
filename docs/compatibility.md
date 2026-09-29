# Compatibility and release identity

[`compatibility/workbench.json`](../compatibility/workbench.json) is the only
editable component pin set. It records the Workbench version and status, DSH,
runtime-kit, and TUI source identities, package identities, integrity values,
toolchains, target platforms, and validation gates. Release tooling and
installers must read this file and reject mismatches before activation. They
must not substitute a branch head, registry `latest`, or relaxed peer
dependency resolution for the recorded identities.

The first distributable Workbench release targets Linux x64. macOS arm64
has two later lanes: native reduced capabilities under
[#48](https://github.com/sympoies/dsh-workbench/issues/48), and full authority
under [#47](https://github.com/sympoies/dsh-workbench/issues/47) with
[nils-cli #1800](https://github.com/sympoies/nils-cli/issues/1800). Neither lane
is implemented or accepted by this Linux release contract. The full-authority lane's
unavailable authoritative finish-line backend does not block Linux acceptance.
Earlier two-platform results below remain historical component and handoff
evidence, not a claim that the combined macOS profile is releasable.

The current `v0.1.6` Linux x64 contract is a **candidate**. It keeps every
0.1.5 source and package pin and extends the reviewed TUI patch so that a
question from the agent reaches the TUI. DSH dispatches `user-questions/request`
in the agent's scope, like approvals, and the pinned TUI registered its answerer
without `{ global: true, prepend: true }`. The question then never reached the
TUI: the turn waited on an answer while the screen showed only its working line.
The 0.1.5 agent delivery acceptance stopped there. The real-TTY acceptance now
answers an agent question in the TUI. The runtime-kit gate and its evidence are
unchanged; the TUI, Web, and cross-interface handoff gates need current evidence
before the contract can be accepted.

The `v0.1.5` Linux x64 contract was **accepted for compatibility**. It keeps the DSH
and runtime-kit pins and moves dsh-TUI to `v0.11.2` at
`dd4137129b91090184e5eaabb7b8a0a74c1b919b`. The npm package was built from that commit's
parent, `1962450006ca63b146d9923c3ec42e7fc62a63d3`; the tagged commit changes
only standalone-executable packaging files that are not in the npm package.
0.11.2 speeds up `/resume`, renders images and LaTeX math in the terminal, and
depends on `dsh-working-activity@0.5.0`. The reviewed TUI patch is rebased onto
0.11.2 with the same behavior. Upstream now writes the user-title payload for
both renames, so the patch no longer changes `appendSessionTitle`, but live
`/rename` still appends without DSH's projection-cache barrier and keeps the
patched title-service path. The first ordinary launch of a home without
`~/.dsh-tui/home.json` now opens the TUI's one-shot workspace home; 0.11.0
skipped it because it read the launch's profile arguments as a first prompt.
The acceptance fixtures record that home as seen and drive the chat screen.
The runtime-kit gate keeps its 0.1.4
[evidence](https://github.com/sympoies/dsh-runtime-kit/actions/runs/36521711113),
and distinct current-version runs supplied the
[TUI](https://github.com/sympoies/dsh-workbench/actions/runs/36540330089), [Web](https://github.com/sympoies/dsh-workbench/actions/runs/36542080773), and
[cross-interface handoff](https://github.com/sympoies/dsh-workbench/actions/runs/36542117064) evidence. Deployments are
accepted separately by the [agent delivery acceptance](agent-acceptance.md).

The `v0.1.4` Linux x64 contract was **accepted for compatibility**. It keeps the DSH
and dsh-TUI pins and the reviewed TUI patch, and moves runtime-kit to commit
`018646bc97448b1e879fab66ff293d3e18181f40`, which adopts the released nils-cli
1.29.4 companions. The runtime-kit source, its DSH patch, and the Workbench
launch are otherwise unchanged. Distinct current-version runs supplied the
[runtime-kit](https://github.com/sympoies/dsh-runtime-kit/actions/runs/36521711113),
[TUI](https://github.com/sympoies/dsh-workbench/actions/runs/36521995963), [Web](https://github.com/sympoies/dsh-workbench/actions/runs/36523161796), and
[cross-interface handoff](https://github.com/sympoies/dsh-workbench/actions/runs/36523180374) evidence. Deployments are
accepted separately by the [agent delivery acceptance](agent-acceptance.md).

The `v0.1.3` Linux x64 contract was **accepted for compatibility**. It keeps the DSH
and dsh-TUI pins and the reviewed TUI patch, and moves runtime-kit to commit
`d3c3dace4540720839b34436a5f3ee9b15f76653`. That revision adopts the released
nils-cli 1.29.3 companions, whose agent-hook no longer blocks read-only commands
with descriptor duplications, quoted glob characters, or mid-word tildes, and
it retires a finish-line ledger whose checkout the agent removed during a turn
instead of ending the turn as `finish-line unavailable`. The runtime-kit DSH
patch is unchanged. Distinct current-version runs supplied the
[runtime-kit](https://github.com/sympoies/dsh-runtime-kit/actions/runs/36508915988),
[TUI](https://github.com/sympoies/dsh-workbench/actions/runs/36509204697), [Web](https://github.com/sympoies/dsh-workbench/actions/runs/36510431654), and
[cross-interface handoff](https://github.com/sympoies/dsh-workbench/actions/runs/36510449853) evidence. Deployments are
accepted separately by the [agent delivery acceptance](agent-acceptance.md).

The `v0.1.2` Linux x64 contract was **accepted for compatibility**. It keeps every
`v0.1.1` source, package, and patch pin. The installed launch now runs DSH as a
full host agent that keeps the machine's tool configuration, and the Workbench
profile keeps the approval policy at `ask`; see
[the Linux release runbook](linux-release.md). The new release version gives
the Web identity, Web artifact, Linux profile lock, and Linux artifact record
new values. Three distinct current-version Linux profile runs supplied the
[TUI](https://github.com/sympoies/dsh-workbench/actions/runs/36481063825), [Web](https://github.com/sympoies/dsh-workbench/actions/runs/36483645255), and
[cross-interface handoff](https://github.com/sympoies/dsh-workbench/actions/runs/36483672331) evidence; the
runtime-kit pin and its evidence are unchanged. Deployments are accepted
separately by the [agent delivery acceptance](agent-acceptance.md).

The `v0.1.1` Linux x64 contract was **accepted for compatibility**. It keeps every
`v0.1.0` source and package pin and extends the reviewed
[TUI compatibility patch](../compatibility/patches/tui-rename.patch) so that the
installed TUI never updates itself. `/update` reports that the pinned
Workbench installation is upgraded by installing a newer Workbench release.
`dsh-tui update` and the internal update path refuse before any registry
lookup, profile write, or `dsh plugin update` process, and the background
registry check is off. Otherwise `/update` would run
`dsh plugin --profile workbench update` against the installed home and drift
the accepted graph in place. The changed patch digest gives the Web identity,
Web artifact, both profile lockfiles, and the Linux artifact record new values.
Three distinct current-version Linux profile runs supplied the
[TUI](https://github.com/sympoies/dsh-workbench/actions/runs/36437868830), [Web](https://github.com/sympoies/dsh-workbench/actions/runs/36439691635), and
[cross-interface handoff](https://github.com/sympoies/dsh-workbench/actions/runs/36443105642) evidence for the changed graph; the
runtime-kit pin and its evidence are unchanged. Contract acceptance does not
publish a product.

The published `v0.1.0` Linux x64 contract was **accepted for compatibility** for
the first distributable release. It retains the accepted rc.13 DSH, TUI, and
runtime-kit source pins, but changes the Workbench/Web release identity and
adds a portable owner installer. Two distinct current-version Linux profile
runs supplied [Web approval evidence](https://github.com/sympoies/dsh-workbench/actions/runs/36382287752)
and [cross-interface handoff evidence](https://github.com/sympoies/dsh-workbench/actions/runs/36382613741).
The source-bound archive, final owner installation, publication audit, and
release are still separate gates. Contract acceptance does not publish a product.

The earlier Linux x64 component graph for `v0.1.0-rc.13` was **accepted for compatibility**.
This records the pinned graph and its installed-profile acceptance; no Workbench
release, portable installer, OCI image, or owner deployment is published by
that status. Those remain separate [#9](https://github.com/sympoies/dsh-workbench/issues/9)
and [#8](https://github.com/sympoies/dsh-workbench/issues/8) gates. Its DSH and TUI package integrity values
come from the npm registry at the pinned package versions. Git commit and tree
values identify the upstream source revisions. The runtime-kit source pins
the merged DSH 0.1.7 support from [PR #272](https://github.com/sympoies/dsh-runtime-kit/pull/272),
the authenticated patched peer closure from
[PR #274](https://github.com/sympoies/dsh-runtime-kit/pull/274), and the typed
finish-line denial diagnostics from
[PR #277](https://github.com/sympoies/dsh-runtime-kit/pull/277), concurrent
teardown repair from [PR #280](https://github.com/sympoies/dsh-runtime-kit/pull/280),
exact committed approval-rejection cleanup from
[PR #283](https://github.com/sympoies/dsh-runtime-kit/pull/283), and owner-bound
crash recovery with canonical managed-session authentication from
[PR #288](https://github.com/sympoies/dsh-runtime-kit/pull/288);
runtime-kit has no published npm release at this revision, so its Git tree is
its source integrity identity. The contract records the upstream package
version `0.0.0` for runtime-kit; that is not a Workbench release version.
These identities were checked on 2026-09-27. Runtime-kit compatibility and
managed-worktree recovery passed its owner CI. The graph's native Web/TUI
browser fixture passed settled text and PNG handoff on Linux x64 and macOS
arm64 in [PR #44](https://github.com/sympoies/dsh-workbench/pull/44). The exact
combined profile also passed frozen installation and runtime-kit doctor on both
platforms. That earlier two-platform result is component evidence only; the
Linux x64 accepted gate below adds governed Bash and cross-interface proof.
Portable installer mismatch rejection and owner deployment remain pending.

The [legacy-home acceptance](https://github.com/sympoies/dsh-workbench/pull/46)
also passed on Linux x64 and macOS arm64 in the
[two-platform profile run](https://github.com/sympoies/dsh-workbench/actions/runs/36300441902).
Its disposable home contains a valid Session V2 archive and a separately saved
backup. Native Web reads the historical exchange, TUI resumes that exact ID
and continues it into Session V4, and Web reopens the continued conversation.
The test checks that the original archive and backup retain their bytes and no
second V4 archive is created. This is copy-only migration evidence for a
synthetic fixture. A real existing home and installed live handoff were
accepted later; see [session handoff](session-handoff.md).

The [combined candidate profile procedure](combined-profile.md) stages the
patched DSH workspace dependency closure and TUI before runtime-kit setup.
The isolated Linux x64 graph passed strict and frozen pnpm installation,
runtime-kit `doctor` with `healthy` status, and real-terminal TUI startup.
This is composition evidence; it does not accept the tuple or establish a
portable release artifact.

The TUI's `dsh-working-activity` dependency declares peers for other DSH
releases and React 18. The selected TUI uses React 19 and declares support for
DSH `0.1.7-rc.1`; unmodified npm and pnpm strict installs reject the combined
graph. The TUI contract therefore records the exact working-activity and React
versions for a Workbench-scoped peer correction. `node scripts/tui-compat.mjs`
renders pnpm overrides for only that package's stale peer edges, nine DSH
packages and React for `dsh-working-activity@0.5.0`, while pinning the TUI's
working-activity dependency and the graph's React version. Among its peers,
the package imports only `@deepseek-ai/schemastery` at runtime; its DSH peers
are type imports, and its Web client is a self-contained bundle. The corrected graph passed a strict frozen install in
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
count because the TUI may emit only the changed digit. Those isolated checks
preceded the accepted combined Linux TUI gate below. The overrides do
not relax peer checks for any other
dependency; a future installer must include them in its frozen graph and
reject an unexpected working-activity version.

Workbench `v0.1.0-rc.3` adds an exact
[`dsh-TUI 0.11.0` patch](../compatibility/patches/tui-rename.patch) for
[#24](https://github.com/sympoies/dsh-workbench/issues/24). Live `/rename`
now calls DSH's session-title service, which records the normalized title
with `messageSeqs: []` and `source.kind: user` and supersedes automatic
title generation. The persisted-session picker writes the same user-title
payload. In the accepted Linux graph, live rename also awaits DSH's public
`sessionProjectionCache.write(session)` durability barrier before updating the
TUI title or acknowledging success. Both `/rename` and recap-title application
handle rejection; a changed channel binding cannot acknowledge the old operation
as a rename of the current session. This preserves the upstream cache's
write-behind policy while making a completed TUI rename visible in an unopened
Web sidebar. The generic TUI port allows `void | Promise<void>` for other
adapters; the patched DSH carrier returns `Promise<void>`.
The patch path and SHA-256 digest are part of the single contract;
the frozen profile lock records pnpm's patch hash. A real-terminal regression
proved manual rename, exact-ID restart, and another completed turn against
the patched profile. It also exercised the stopped-session title writer and
another exact-ID restart. The native Web browser acceptance now opens a
TUI-renamed Session V4 archive under the same ID and verifies its title,
prompt, and answer before and after a Web Host restart. The installed Linux
cross-interface gate passed below. Workbench does not remap recorded workspace
paths ([workspace boundary](session-handoff.md#workspace-boundary)).

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
graph passed hosted Linux x64 and macOS arm64 CI, including an activated Web
turn, but governed Bash remains a separate acceptance gate.
The publication comparison treats the reviewed Web artifact digest as part of
the release identity, including the first addition of the record. A changed
digest requires a higher Workbench release version.
Workbench `v0.1.0-rc.7` pins runtime-kit's typed nils host-denial diagnostics
and records the resulting Web plugin identity and artifact digest. This
diagnostic change does not provide the missing macOS finish-line backend or
accept the candidate graph.
Workbench `v0.1.0-rc.9` extends the exact TUI 0.11.0 compatibility patch so
its approval listener receives requests dispatched in a DSH agent scope and
runs before DSH's global `Include` listener, which otherwise ends the
waterfall before TUI can display an approval. The pinned TUI returns from its
headless-host path before registering this listener; the combined browser
acceptance therefore loads the same patched TUI bundle while proving Web
approval still works. The TUI approval store still validates that each request
belongs to a live tool call before presenting it. The patch digest, frozen TUI
profile lock, Web identity, and reviewed Web artifact digest are updated
together. Combined-profile allow/reject acceptance remains required before
this candidate can be accepted.
Workbench `v0.1.0-rc.10` pins the merged runtime-kit finish-line lifecycle
repair at commit `407da96d891a6457b20b375406e2460cfd576b6b` and its exact
Git tree. The combined-profile acceptance now checks browser approval allow
and reject in the installed `workbench` profile, including command execution,
Session V4 approval decisions, and durable tool results. The Linux TUI
finish-line gate must pass against this pin. The macOS arm64 candidate remains
pending an OS-enforced descendant-cleanup backend under
[`nils-cli#1800`](https://github.com/sympoies/nils-cli/issues/1800).
The pin also includes runtime-kit's managed DSH home instructions at
`<dshHome>/AGENTS.md`. Setup, update, and rollback preview refuse an existing
file without a recorded runtime-kit digest with exit 65 and
`agent-home-unmanaged`, leaving that file unchanged. An operator must move or
merge the existing instructions before retrying; the portable installer must
test this migration on copies under [#9](https://github.com/sympoies/dsh-workbench/issues/9).
The [rc.7 combined-profile matrix](https://github.com/sympoies/dsh-workbench/actions/runs/36242300610)
passed this refusal check and clean activation on Linux x64 and macOS arm64.

[`compatibility/tui-profile/pnpm-lock.yaml`](../compatibility/tui-profile/pnpm-lock.yaml)
is a reviewed, generated lockfile for the disposable TUI profile used by the
[handoff procedure](session-handoff.md). It freezes that profile's transitive
dependencies and the exact compatibility patch; it is not a second editable
component version contract or an
accepted installer receipt. CI verifies a strict frozen install with it. A
candidate profile update must regenerate and review this lockfile against the
single component contract before the handoff proof is repeated.

## Gate

The current Linux graph pins runtime-kit commit
`018646bc97448b1e879fab66ff293d3e18181f40` and its authenticated nils-cli
1.29.4 release (the accepted rc.13 graph pinned `00f91aad` with nils-cli
1.29.0). Finish-line open binds authority to the actual DSH process.
A live owner still prevents takeover. After a crash, nils must prove that the
owner has died, perform authoritative cleanup, rotate authority, and invalidate
the old validation evidence before returning a recovered capability. A resumed
turn does not inherit permission to execute an unapproved command. Sessions
without a committed recoverable owner binding still fail closed; this protocol
does not permit stealing another live owner's authority. The installed Linux
gate proved pending-approval SIGKILL recovery through TUI and reopening in
Web, alongside ordinary allow/reject and handoff. The four distinct public
records in the contract are the
[runtime-kit owner CI](https://github.com/sympoies/dsh-runtime-kit/actions/runs/36348019468),
[combined TUI profile](https://github.com/sympoies/dsh-workbench/actions/runs/36351502065),
[combined Web and recovery profile](https://github.com/sympoies/dsh-workbench/actions/runs/36353719094),
and [cross-workspace handoff profile](https://github.com/sympoies/dsh-workbench/actions/runs/36357463622).
The final run covers ordinary and recovered Bash allow/reject, exact Session V4
continuation, distinct canonical workspace mapping, and unavailable historical
workspace handling. Runtime-kit's owner CI supplies dependency evidence; the
Workbench profile runs supply installed interface and handoff evidence.

`node scripts/contract.mjs check` validates structure and immutable pin shape.
`node scripts/contract.mjs require-accepted` is the contract activation gate:
it passes for this Linux x64 compatibility graph. An accepted contract requires all three
components marked accepted and distinct public evidence links for runtime-kit,
TUI, Web, and cross-interface handoff on every declared target platform. A
local schema check alone does not establish that upstream packages match the
recorded hashes; the release build and installation must verify those bytes.
The [Linux release envelope](linux-release.md) defines the separate
externally authenticated payload-file check before installation.
Schema 3 adds the TUI patch identity; the compare gate reads schema 1 and 2
candidates only as previous releases.

The current common runtime baseline is Node.js 24.3.0 or newer on the target platform set recorded in the
contract. A target platform is planned while the contract is a candidate; it
becomes compatible when the graph gates pass. Distribution and installed
product support still require the separate release and owner installation
gates. Upstream package manager versions are recorded as
source-build facts. Workbench pins pnpm `11.24.0` for its own graph. The
generated pnpm settings explicitly exempt only the exact selected TUI release
from a local minimum-release-age policy, because a freshly published release
cannot otherwise pass that independent supply-chain gate; its package integrity
still comes from the contract and strict frozen installation remains required.

## Workbench versions

Workbench uses its own SemVer release identity and tags `v<version>`. The
target version in the accepted contract is reserved for this tuple; it is not
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
SHA-256 digest of the immutable graph (release, runtime, component sources,
packages, toolchains, peer overrides and patches) and reports the release and
three component pins. Schema V2 excludes candidate/accepted status and
acceptance evidence so promoting the same tested bytes cannot change the
artifact. The external contract owns acceptance; the Web package does not
advertise an acceptance verdict. Its package build checks that identity against
the contract.
This identifies a graph build; it does not prove the actual installed
runtime-kit or TUI package matches. Future Web images, TUI packages, install
receipts, and release metadata must verify the installed graph and derive
their identity from the same contract before activation.
