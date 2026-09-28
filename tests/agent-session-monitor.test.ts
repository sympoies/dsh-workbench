import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findSession, parseSessionText, readSessionArchive, summarizeSession,
  type SessionEvent } from '../src/agent-session-monitor.ts';

const cli = new URL('../scripts/agent-acceptance.ts', import.meta.url).pathname;
const header = (cwd: string): SessionEvent => ({ type: 'session', cwd });
const bash = (turn: number, callId: string, command: string): SessionEvent => ({ type: 'tool/call', time: 3,
  data: { turn, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) } });

test('a supervisor summary tracks turns, tools, and approvals without message text', () => {
  const events: SessionEvent[] = [
    header('/work/repo'),
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'user/message', time: 1, data: { text: 'secret task text' } },
    bash(1, 'call-1', 'npm test'),
    { type: 'tool/result', time: 2, data: { message: { toolCallId: 'call-1', isError: true, content: [] } } },
    bash(1, 'call-2', 'git push origin feat/report'),
    { type: 'approval/asked', time: 4, data: { id: 'ask-1', toolName: 'bash', callId: 'call-2', reason: 'network' } },
  ];
  const pending = summarizeSession('s-1', events);
  assert.equal(pending.state, 'approval-pending');
  assert.equal(pending.cwd, '/work/repo');
  assert.deepEqual(pending.tools, { bash: 2 });
  assert.equal(pending.toolErrors, 1);
  assert.deepEqual(pending.openApprovals, [{ id: 'ask-1', tool: 'bash', reason: 'network',
    arguments: JSON.stringify({ command: 'git push origin feat/report' }) }]);
  assert.doesNotMatch(JSON.stringify(pending), /secret task text/);

  events.push({ type: 'approval/decided', time: 5, data: { id: 'ask-1', outcome: 'allowed-once' } });
  const running = summarizeSession('s-1', events);
  assert.equal(running.state, 'running');
  assert.deepEqual(running.approvals, { asked: 1, decided: 1, outcomes: ['allowed-once'] });

  events.push({ type: 'turn/end', time: 6, data: { turn: 1, reason: { kind: 'completed' } } });
  const idle = summarizeSession('s-1', events);
  assert.equal(idle.state, 'idle');
  assert.deepEqual(idle.turns, { started: 1, ended: 1, lastEnd: 'completed' });
  assert.equal(idle.lastEventTime, 6);
});

test('a torn final line from a live writer is skipped', () => {
  assert.deepEqual(parseSessionText('{"type":"session"}\n{"type":"turn/st').map(event => event.type), ['session']);
});

test('sessions are found by exact id, by recorded workspace, or as the newest archive', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-monitor-'));
  try {
    const write = (id: string, cwd: string, mtime: number) => {
      const directory = join(home, 'sessions', 'workspace-key', id);
      mkdirSync(directory, { recursive: true });
      const plain = join(directory, 'session.v4.jsonl');
      writeFileSync(plain, `${JSON.stringify(header(cwd))}\n${JSON.stringify({ type: 'turn/start', time: 1 })}\n`);
      const compressed = spawnSync('zstd', ['-q', '--rm', plain, '-o', `${plain}.zstd`]);
      assert.equal(compressed.status, 0, String(compressed.stderr));
      utimesSync(`${plain}.zstd`, mtime, mtime);
    };
    write('older', '/work/a', 1_000);
    write('newer', '/work/b', 2_000);
    assert.equal(findSession(home, {})?.session, 'newer');
    assert.equal(findSession(home, { session: 'older' })?.session, 'older');
    assert.equal(findSession(home, { cwd: '/work/a' })?.session, 'older');
    assert.equal(findSession(home, { cwd: '/work/missing' }), undefined);
    const events = readSessionArchive(findSession(home, { cwd: '/work/b' })!.path);
    assert.equal(summarizeSession('newer', events).state, 'running');

    const status = spawnSync(process.execPath, [cli, 'status', '--dsh-home', home, '--session', 'older'],
      { encoding: 'utf8', timeout: 20_000 });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).cwd, '/work/a');
    const waited = spawnSync(process.execPath, [cli, 'wait', '--dsh-home', home, '--session', 'newer',
      '--stall-seconds', '0', '--timeout-seconds', '30'], { encoding: 'utf8', timeout: 40_000 });
    assert.equal(waited.status, 0, waited.stderr);
    assert.equal(JSON.parse(waited.stdout).stop, 'stalled');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
