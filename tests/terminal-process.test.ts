import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stopTerminal } from './terminal-process.ts';

const linux = process.platform === 'linux';

function active(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/^\d+ \(.+\) [ZX] /.test(stat);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

test('terminal cleanup handles an already exited wrapper and its descendant', { skip: !linux }, async () => {
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log(child.pid);
    child.unref();
  `], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let nestedPid = 0;
  try {
    const exited = once(parent, 'exit');
    const [output] = await once(parent.stdout!, 'data');
    nestedPid = Number(String(output).trim());
    assert.ok(nestedPid > 0);
    await exited;
    assert.ok(active(nestedPid));
    const started = Date.now();
    await stopTerminal(parent);
    assert.ok(Date.now() - started < 1_000, 'already exited cleanup waited for a deadline');
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    assert.equal(active(nestedPid), false, 'descendant survived wrapper cleanup');
  } finally {
    if (parent.pid) {
      try { process.kill(-parent.pid, 'SIGKILL'); } catch { /* group already exited */ }
    }
  }
});

test('terminal cleanup force-kills an unresponsive process group', { skip: !linux }, async () => {
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    const [output] = await once(child.stdout!, 'data');
    assert.match(String(output), /ready/);
    const started = Date.now();
    await stopTerminal(child);
    assert.ok(Date.now() - started < 15_000, 'cleanup exceeded its deadline');
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already exited */ }
    }
  }
});
