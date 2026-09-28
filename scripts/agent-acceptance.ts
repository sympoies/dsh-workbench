// Supervise an installed Workbench TUI that works on a real task: drive it in tmux, watch
// its Session V4 archive, and verify the pull request it delivers. See docs/agent-acceptance.md.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findSession, readSessionArchive, summarizeSession } from '../src/agent-session-monitor.ts';

const [command, ...rest] = process.argv.slice(2);
const options = new Map<string, string>();
const passthrough: string[] = [];
for (let index = 0; index < rest.length; index += 1) {
  if (rest[index] === '--') { passthrough.push(...rest.slice(index + 1)); break; }
  if (!rest[index].startsWith('--')) throw new Error(`unexpected argument: ${rest[index]}`);
  options.set(rest[index].slice(2), rest[index + 1] ?? '');
  index += 1;
}
const required = (name: string) => {
  const value = options.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
};
const number = (name: string, fallback: number) => Number(options.get(name) ?? fallback);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

function run(executable: string, args: string[], allowFailure = false): string {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 64_000_000 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`${executable} ${args[0] ?? ''} failed: ${(result.stderr || String(result.error)).trim()}`);
  }
  return result.stdout ?? '';
}
const tmux = (...args: string[]) => run('tmux', args);
const capture = (name: string) => tmux('capture-pane', '-p', '-t', name);

function summary() {
  const archive = findSession(required('dsh-home'),
    { session: options.get('session'), cwd: options.get('cwd') && resolve(options.get('cwd')!) });
  if (!archive) return undefined;
  return summarizeSession(archive.session, readSessionArchive(archive.path));
}

async function waitForStop() {
  const stallMs = number('stall-seconds', 600) * 1000;
  const deadline = Date.now() + number('timeout-seconds', 7200) * 1000;
  const minEnded = number('min-ended', 0);
  const minDecided = number('min-decided', 0);
  for (;;) {
    const current = summary();
    if (current) {
      const settled = current.approvals.decided >= minDecided;
      if (settled && current.state === 'approval-pending') return { stop: 'approval-pending', ...current };
      if (settled && current.state === 'idle' && current.turns.ended >= minEnded) return { stop: 'idle', ...current };
      if (current.state === 'running' && current.lastEventTime && Date.now() - current.lastEventTime > stallMs) {
        return { stop: 'stalled', ...current };
      }
    }
    if (Date.now() > deadline) return { stop: 'timeout', ...current };
    await sleep(5_000);
  }
}

async function startTui() {
  const name = required('name');
  tmux('new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', resolve(required('cwd')),
    required('launcher'), '--port=0', ...passthrough);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (/Explore the uncharted!|⌸ ❯/.test(capture(name))) return { started: name };
    await sleep(1_000);
  }
  throw new Error(`TUI in ${name} did not reach its prompt: ${capture(name).trim().slice(-500)}`);
}

async function exitTui() {
  const name = required('name');
  tmux('send-keys', '-t', name, 'C-c');
  await sleep(1_000);
  tmux('send-keys', '-t', name, 'C-c');
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await sleep(1_000);
    if (spawnSync('tmux', ['has-session', '-t', name]).status !== 0) return { exited: name };
  }
  tmux('kill-session', '-t', name);
  return { exited: name, killed: true };
}

async function sendPrompt() {
  const name = required('name');
  tmux('load-buffer', '-b', 'agent-acceptance', resolve(required('file')));
  tmux('paste-buffer', '-p', '-d', '-b', 'agent-acceptance', '-t', name);
  await sleep(1_500);
  tmux('send-keys', '-t', name, 'Enter');
  return { prompted: name };
}

function verifyPullRequest() {
  const repo = required('repo');
  const pr = required('pr');
  const view = JSON.parse(run('gh', ['pr', 'view', pr, '-R', repo, '--json',
    'state,baseRefName,headRefName,headRefOid,isDraft,url,statusCheckRollup']));
  const commits = JSON.parse(run('gh', ['api', `repos/${repo}/pulls/${pr}/commits`, '--paginate']));
  const unsigned = commits.filter((commit: any) => commit.commit?.verification?.verified !== true)
    .map((commit: any) => commit.sha.slice(0, 12));
  const checks = (view.statusCheckRollup ?? []).map((check: any) => ({
    name: check.name ?? check.context, conclusion: check.conclusion ?? check.state }));
  const failures: string[] = [];
  if (view.state !== 'OPEN') failures.push(`pull request is ${view.state}`);
  if (view.baseRefName !== 'main' || view.headRefName === 'main') failures.push('pull request must target main from a branch');
  if (unsigned.length) failures.push(`unverified commit signatures: ${unsigned.join(', ')}`);
  if (!checks.length || checks.some((check: any) => check.conclusion !== 'SUCCESS')) failures.push('checks did not all succeed');
  let verifier = { status: null as number | null, output: '' };
  const task = options.get('verifier');
  if (task) {
    const checkout = mkdtempSync(join(tmpdir(), 'agent-acceptance-'));
    try {
      run('gh', ['repo', 'clone', repo, checkout, '--', '--quiet']);
      run('git', ['-C', checkout, 'fetch', '--quiet', 'origin', view.headRefOid]);
      run('git', ['-C', checkout, 'checkout', '--quiet', '--detach', view.headRefOid]);
      const result = spawnSync(process.execPath, [resolve(task), checkout], { encoding: 'utf8', timeout: 300_000 });
      verifier = { status: result.status, output: `${result.stdout}${result.stderr}`.trim().slice(-4000) };
      if (result.status !== 0) failures.push('task verifier failed');
    } finally { rmSync(checkout, { recursive: true, force: true }); }
  }
  return { result: failures.length ? 'fail' : 'pass', url: view.url, head: view.headRefOid,
    commits: commits.length, unsigned, checks, verifier, failures };
}

const commands: Record<string, () => unknown> = {
  status: () => summary() ?? { state: 'no-session' },
  wait: waitForStop,
  start: startTui,
  prompt: sendPrompt,
  approve: () => { tmux('send-keys', '-t', required('name'), '1'); return { approved: true }; },
  reject: () => { tmux('send-keys', '-t', required('name'), 'Escape'); return { rejected: true }; },
  capture: () => ({ screen: capture(required('name')) }),
  exit: exitTui,
  'verify-pr': verifyPullRequest,
};
if (!command || !commands[command]) {
  throw new Error(`usage: agent-acceptance.ts ${Object.keys(commands).join('|')} [--option value ...]`);
}
const output = await commands[command]();
process.stdout.write(`${JSON.stringify(output, null, 1)}\n`);
if (command === 'verify-pr' && (output as { result: string }).result !== 'pass') process.exitCode = 1;
