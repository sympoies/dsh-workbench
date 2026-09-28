# Session visibility and handoff

This document records the observed two-process behavior of the Linux x64
**accepted compatibility graph**: DSH 0.1.7-rc.1, dsh-TUI 0.11.0, and the
pinned dsh-runtime-kit revision. It selects a service-stop topology for the
first Workbench milestone. It is not a published release or a migration
procedure for an existing DSH home.

## Supported first-milestone topology

Web Host and TUI are separate DSH processes using the same DSH release, a
shared **explicit** persistence root, and the same canonical workspace path.
Only one interface owns a session writer at a time. To hand off a session:

1. Let the current turn finish or cancel it and wait for cancellation to settle.
   Do not hand off while a tool or approval is pending.
2. Exit the TUI process, or stop the entire Web Host process. Closing one Web
   browser tab, navigating away, or opening a new Web session is not a writer
   release signal while the Host remains active.
3. Confirm the former process has exited and released the session writer. If
   the other interface still reports contention, keep the original process
   stopped and investigate; never remove a lock file or force another writer.
4. Start the other interface with the same persistence root and canonical
   workspace, list its sessions, and resume the exact session ID. Verify its
   last settled turn before entering a new prompt.

Workbench must show writer contention as **in use elsewhere**. The pinned
TUI currently reports a Web-held writer as an unreadable or corrupt stored log;
that message is inaccurate. An installer or launcher must use the pinned DSH
binary and frozen graph, rather than whichever `dsh` appears first on PATH.
Runtime update commands must not silently change a pinned install.
The Workbench-scoped TUI patch makes `/rename` resumable in a real TTY. Native
Web opens the renamed session with its authoritative title and history in the
automated Linux browser acceptance. The installed Linux compatibility handoff
gate has passed, and the portable owner installation is delivered. Recorded
workspace paths are not remapped; see [Workspace boundary](#workspace-boundary).

This topology requires stopping Web service for a Web-to-TUI handoff. It does
not offer simultaneous Web and TUI editing or per-session Web writer release.
The official Web Host held a session lock even after the tab viewing that
session closed, provided another Web tab kept the Host active. A single DSH
Host with two clients would require a separate TUI integration design and is
not required for the first milestone.

## Workspace boundary

DSH records the canonical absolute path of the workspace where each session
started, and only a workspace at that path can continue the session. Workbench
adds no workspace policy of its own:

- The installer takes no workspace roots. The TUI starts a session in the
  directory where it is launched. Native Web's directory picker can browse and
  choose any directory the operating-system account can read. The account's
  file permissions are the boundary, as for a TUI launched in that directory.
  Web binds only the address the deployment chooses, with no public default,
  and requires its launch token.
- Workbench does not remap recorded paths. A session whose workspace was
  moved, renamed, or recorded on another host opens as read-only history
  without an active editor, and the missing path is not recreated.
- Workbench never rewrites a session archive to change its recorded path.
  Continuing sessions across hosts or paths needs a path-mapping capability in
  upstream DSH first; adopting it would be a new Workbench release, not an
  owner-side edit.

## Reproduce with disposable state

Use only a fresh disposable directory and a **separate empty** workspace.
Run these commands from the Workbench repository root. They assume an installed
graph built from
[`compatibility/workbench.json`](../compatibility/workbench.json). Replace
`/path/to/pinned/dsh` with that graph's absolute DSH executable. Use the
pinned pnpm version from the contract. Set a provider credential through your
usual private environment; do not copy it into a fixture, command transcript,
or issue.

```sh
set -eu
export WORKBENCH_ROOT="$(pwd -P)"
export DSH_HOME="$(mktemp -d)"
export DSH_AGENTS_HOME="$(mktemp -d)"
export WORKSPACE="$(mktemp -d)"
export DSH_BIN=/path/to/pinned/dsh
export PATH="$(dirname "$DSH_BIN"):$PATH"
test "$(command -v dsh)" = "$DSH_BIN" || exit 1
test "$(pnpm --version)" = "$(node -p 'require(process.argv[1]).runtime.pnpm' "$WORKBENCH_ROOT/compatibility/workbench.json")" || exit 1
profile="$DSH_HOME/profiles/dsh-tui"
mkdir -p "$profile"
node - "$WORKBENCH_ROOT/compatibility/workbench.json" > "$profile/package.json" <<'NODE'
const { readFileSync } = require('node:fs');
const contract = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const tui = contract.components.tui.package;
process.stdout.write(JSON.stringify({
  name: 'dsh-profile-dsh-tui',
  private: true,
  dependencies: { [tui.name]: tui.version },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', tui.name] } },
}, null, 2) + '\n');
NODE
printf '[]\n' > "$profile/cordis.yml"
printf '[]\n' > "$profile/cordis.patch.yml"
node "$WORKBENCH_ROOT/scripts/tui-compat.mjs" > "$profile/pnpm-workspace.yaml"
cp "$WORKBENCH_ROOT/compatibility/tui-profile/pnpm-lock.yaml" "$profile/pnpm-lock.yaml"
mkdir -p "$profile/patches"
cp "$WORKBENCH_ROOT/compatibility/patches/tui-rename.patch" "$profile/patches/tui-rename.patch"
(cd "$profile" && pnpm install --frozen-lockfile --strict-peer-dependencies --ignore-scripts)
cd "$WORKSPACE"
"$DSH_BIN" --profile dsh-tui
```

In the TUI, create a session, submit a harmless prompt, let its answer
complete, call a harmless local tool if available, record the displayed
session ID, and exit normally. In that shell, run
`export SESSION_ID='paste-the-displayed-id-here'`. Keep the five values
`DSH_HOME`, `DSH_AGENTS_HOME`, `WORKSPACE`, `DSH_BIN`, and `SESSION_ID`
available, along with the PATH prefix; print only these non-secret values
locally if needed. Do not run `mktemp` again for the second
process. In the same workspace and environment, start the native Web Host:

```sh
"$DSH_BIN" --profile web --no-open --port 31607
```

Keep Web's startup URL and any access token private. Open it in a browser,
locate the recorded TUI session, and check the prompt, answer, tool call and
result. While Web still has the session open, start another terminal. Copy the
recorded values into that shell; the quoted placeholders below are **the
values already created**, not instructions to make new directories:

```sh
export DSH_HOME='copy-existing-value'
export DSH_AGENTS_HOME='copy-existing-value'
export WORKSPACE='copy-existing-value'
export DSH_BIN='copy-existing-value'
export SESSION_ID='copy-recorded-id'
export PATH="$(dirname "$DSH_BIN"):$PATH"
test "$(command -v dsh)" = "$DSH_BIN" || exit 1
cd "$WORKSPACE"
```

Then run:

```sh
"$DSH_BIN" --profile dsh-tui --resume "$SESSION_ID"
```

The second process must refuse the writer without changing the session log.
For a byte-level check, hash the matching `session.v4.jsonl.zstd` file
immediately before and after this rejected resume. The log lives under
`$DSH_HOME/sessions/`; identify it by the session ID rather than guessing
the workspace-derived directory name. On Linux, `fuser` can identify the
process holding its adjacent `session.lock`; on macOS, use `lsof`.

Close the viewing browser tab while keeping a second Web tab open. Recheck
the lock: the Web Host can still hold it. Stop the **Web Host process**, then
resume the same ID in TUI and check the settled history. For the reverse
direction, exit TUI normally, start Web Host again, and open that ID in Web.
Never run this proof against an existing user profile or session store.

## Observed result and remaining gates

The committed fixture lockfile holds the reviewed transitive TUI profile graph;
the procedure copies it and uses only a strict frozen install. The first
two-process proof used an earlier exact TUI profile graph with the same
contract component revisions. On 2026-09-25 that graph launched the real TUI.
A streamed model reply and a Bash tool
result survived TUI exit and exact-ID resume. Native Web listed and opened
the TUI-created session with its prompt, reply, tool call, and result. With
Web holding the writer, a TUI resume was refused and the compressed log's
SHA-256 stayed unchanged. Web retained the lock across a viewing-tab close
while another tab kept Web Host active. After Web Host stopped, TUI resumed
the same ID and displayed the same settled history. TUI-to-TUI contention
was also rejected, then resolved after the first TUI exited. The committed
profile lockfile separately passed a fresh-home strict frozen install and a
second settled-text TUI-to-Web-to-TUI exact-ID handoff. The later run did not
repeat tool or approval continuity. An automated Linux real-TTY scenario now
also proves a 72-turn TUI session's unique title remains visible in the
`/resume` list after exit and exact-ID resume, and that a further turn
completes in the same Session V4 archive. It does not exercise Web in that
scenario.

These observations cover settled text and tool turns in one disposable Linux
fixture. Manual and stopped-session TUI rename with exact-ID TUI restart are additionally covered
by the patched graph's real-terminal acceptance. Native Web browser acceptance
also opens a TUI-renamed session under the same ID with its prior prompt,
answer, and title before and after a Web Host restart. The same automated
fixture checks that a Web-held writer rejects TUI resume without changing the
compressed archive. After Web Host stops, TUI resumes a Web-created session,
completes another turn, and Web reads that continuation on restart. These
checks also reject TUI exact-ID resume while Web awaits tool approval: the
pending archive's existing bytes remain intact and Web can still approve its
own turn. The browser fixture also terminates Web Host with SIGKILL while it
owns a settled session, then requires TUI continuation and native Web recovery
under the same ID. A separate browser scenario terminates Web Host with
SIGKILL while a Bash approval is pending. It verifies that the unapproved
command did not execute, TUI resumes the same ID and closes the interrupted
turn, and the same TUI process completes a text continuation and new Bash allow
and reject turns in that session. Each new request has a fresh approval ID;
allow executes exactly once and reject leaves the execution count unchanged.
The archive retains its pre-crash history and both new turns complete. Web
reads the continuation after restart.
This proves recovery for the approval-wait state only; it does not establish
cancellation of an executing command or turn, recovery from crashes at other
active-turn phases, live cross-interface title updates, or complete
projection-cache behavior. The browser fixture
also exercises a synthetic PNG uploaded in native Web: Session V4 retains the
attachment identity and dimensions without embedding raw bytes in the message,
the exact-ID TUI continuation sends the same image bytes to the model, and Web
reopens the image after TUI exits. This covers one settled PNG handoff, not
other attachment types or interruption while an upload is pending.
The fixture also places a synthetic Session V2 archive in a disposable DSH
home, retaining a byte-identical rollback copy outside that home. Native Web
lists and reads the historical prompt and answer under the same ID without
changing the V2 source. After Web Host stops, TUI resumes that ID, includes
the historical exchange in its next model request, and completes a Session V4
continuation without creating another session ID. Web then reopens the V4
history under the same ID. This covers
one V2 text conversation, not V0, V1, V3, attachments or tools in historical
archives, or a real user's existing home.

The installed Linux browser fixture also creates a second TUI session under a
different canonical workspace. Native Web starts in the first workspace and
lists both exact IDs with their recorded canonical paths. It opens the second
session's settled title and history, then returns to the first for the
remaining handoff scenarios. After the second directory is moved away, a cold
Web Host still lists the old session identity; selecting it does not expose an
active editor. This checks a missing local path, not a different OS account or
a remote filesystem permission boundary; the
[workspace boundary](#workspace-boundary) states what Workbench does not map.

Treat a V2-to-V4 continuation as a one-way format upgrade. Before trying a
future installer against an existing home, stop both writers and make a
separate, complete copy of that DSH home, including sessions and profile state.
Test the upgrade on another copy and verify exact IDs and history before any
deployment change. To roll back, stop both interfaces and restore the whole
pre-upgrade home with the old binary; do not point an older binary at a home
that has published V4 generations or merge selected files from two homes.
An owner acceptance on 2026-09-28 applied this procedure to a real existing
home from DSH 0.1.6: 34 Session archives, all header version 0, five of whose
recorded workspaces no longer existed. Only a complete copy was used; the
original home was never opened by Workbench and stayed byte-identical. After
its `sessions/` directory was copied into a fresh installed Workbench 0.1.0
home, the installed Web listed all 34 exact IDs with their recorded workspaces
and left every archive unchanged. The installed TUI resumed version 0 sessions
by exact ID, sent the prior exchanges with the next model request, and wrote a
V4 generation beside the untouched version 0 archive under the same ID; Web
reopened the continued session. A session whose workspace is gone opened as
read-only history without an active editor and without recreating the path.
The Web sidebar showed only one of the five missing-workspace sessions, although
the session list API returned all five. The restored pre-upgrade copy matched
the original byte for byte. Per-session evidence stays in the owner's private
record.

Portable installation, copy-only upgrade and rollback, and publication have
passed ([#9](https://github.com/sympoies/dsh-workbench/issues/9)), after the
public source and artifact audit
([#8](https://github.com/sympoies/dsh-workbench/issues/8)). Owner path mapping
is out of scope; see [Workspace boundary](#workspace-boundary).
Existing homes must be tested on copies with a rollback plan before any
private deployment changes.
