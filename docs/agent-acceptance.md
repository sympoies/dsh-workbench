# Agent delivery acceptance

Every deployment of an installed Workbench release is accepted by an external
agent, not by user feedback. The external agent (Codex or Claude Code on the
same host) gives the installed TUI a real multi-turn task, restarts it in the
middle, and accepts the deployment only when the Workbench agent delivers a
correct pull request. Users still report the bugs they meet in daily use; this
gate proves that each deployment can do real delivery work before anyone
relies on it.

## Inputs

- An installed release: its `bin/workbench-tui` launcher and its DSH home
  (`dshHome` in `launch-config.json`). The launcher runs DSH as a full host agent
  (see [the Linux release runbook](linux-release.md)), so the Workbench agent
  uses the host's own Git identity, commit signing, and GitHub CLI login.
- The fixture repository
  [sympoies/dsh-workbench-acceptance](https://github.com/sympoies/dsh-workbench-acceptance),
  a small Node.js tool whose `main` stays at the same baseline for every run.
- A task from [`acceptance/agent-tasks/`](../acceptance/agent-tasks): two
  prompts and a hidden verifier. The verifier is never shown to the Workbench
  agent.
- `tmux`, `zstd`, and a GitHub CLI login on the host.
- A host Git configuration that resolves the owner's identity and signing key
  in non-interactive processes too. The TUI inherits the environment of the
  tmux server or terminal host, not of an interactive shell, and GitHub only
  verifies a signature whose committer email belongs to the key's account.

## Tools

`node scripts/agent-acceptance.ts <command>` drives and observes one TUI in a
named tmux session and prints JSON:

| Command | Purpose |
| --- | --- |
| `start --name N --launcher BIN --cwd DIR [-- ARGS]` | Start the TUI (with `--port=0`) and wait for its prompt. Pass `-- --resume ID` to resume. |
| `prompt --name N --file F` | Paste a prompt file as one bracketed paste and submit it. |
| `status --dsh-home H (--session ID \| --cwd DIR)` | Summarize the Session V4 archive: state, turns, tool calls and errors, approvals, and any open approval with its tool arguments. Message text is never printed. |
| `wait --dsh-home H --session ID [--min-ended N] [--min-decided N] [--stall-seconds S] [--timeout-seconds T]` | Block until the session is idle, asks for approval, stalls, or times out. |
| `approve` / `reject --name N` | Answer the approval prompt on screen. |
| `capture --name N` | Print the current screen. |
| `exit --name N` | Leave the TUI with a double Ctrl-C. |
| `verify-pr --repo R --pr N --verifier F` | Check that the pull request is open against `main` with every commit signature verified and every check successful, then run the task verifier on its head. |

## Procedure

1. Clone the fixture `main` into a new owner-only run directory. Never reuse a
   directory: sessions are keyed by their canonical workspace, and a session
   keeps the permission and approval policy it was created with, so every run
   needs a new session under the release being accepted.
2. `start` the installed TUI in that directory, `prompt` with the task's
   `prompt-1.md`, and `wait --min-ended 1` until the session is idle.
   The archive still shows the previous stop until DSH persists the next
   event, so always pass the gates: `--min-ended` is the number of turns that
   must have ended, and `--min-decided` is one more than the decided approvals
   before your last `approve` or `reject`.
3. At each stop, act only as the task's operator:
   - `approval-pending`: allow a request that stays within the task (the run
     checkout, its managed worktrees, and the fixture remote); reject anything
     that touches other repositories, credentials, or host configuration.
     Record every decision with the request, then `wait` again with the raised
     `--min-decided`.
   - `idle`: confirm `turns.lastEnd` is `completed`.
   - `stalled` or `timeout`: capture the screen and record it. The run fails;
     do not send hints.
4. `exit` the TUI, `start` it again with `-- --resume <session-id>`, and confirm
   with `status --session` that the same session continues. `prompt` with
   `prompt-2.md` and `wait --min-ended 2` until the second turn ends.
5. Once the pull request's checks have finished, run `verify-pr` with the
   task's `verify.mjs`. It reports pending checks separately from failed ones.
6. Close the pull request without merging and delete its branch. Remove the
   managed worktrees the Workbench agent created for the run with
   `git-cli worktree remove`; they live outside the run directory. Then remove
   the run directory.

The operator sends only the two task prompts. Rephrasing a prompt, explaining
a failure, or fixing the agent's work invalidates the run.

## Pass criteria

- `verify-pr` reports `pass`: signed commits, successful checks, and a task
  verifier pass on the delivered head.
- One session ID spans both prompts across the TUI exit and resume, and every
  turn ended as `completed`.
- agent-hook stayed in force: no policy was downgraded or bypassed for the run.

## Evidence

Keep the private run record outside the repository: each `wait` result,
approval decisions with their requests, screens captured at stops, and the
`verify-pr` output. Publish only a path-free summary on the release's tracking
issue: release version, task, session turn and tool-call counts, approval
count, the pull request URL, and the verification result. Never publish
transcripts or session archives.
