import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WorkbenchContract } from '../src/contract-types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(fileURLToPath(new URL('../compatibility/workbench.json', import.meta.url)), 'utf8')) as WorkbenchContract;
const renderer = fileURLToPath(new URL('../scripts/tui-compat.mjs', import.meta.url));
const profileLock = fileURLToPath(new URL('../compatibility/tui-profile/pnpm-lock.yaml', import.meta.url));

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300_000 });
  assert.equal(result.error, undefined, `${command} could not start`);
  return result;
}

function errorCode(result: ReturnType<typeof run>): string {
  return /\[ERR_PNPM_[A-Z_]+\]/.exec(`${result.stdout}\n${result.stderr}`)?.[0] ??
    `exit ${result.status}`;
}

test('pinned pnpm rejects the stale TUI graph and installs the reviewed correction', { timeout: 600_000 }, () => {
  const pinnedPnpm = contract.runtime.pnpm;
  const pnpmVersion = run('pnpm', ['--version'], root);
  assert.equal(pnpmVersion.status, 0, errorCode(pnpmVersion));
  assert.equal(pnpmVersion.stdout.trim(), pinnedPnpm);

  const rendered = run(process.execPath, [renderer], root);
  assert.equal(rendered.status, 0);
  const split = rendered.stdout.indexOf('overrides:\n');
  assert.ok(split > 0);

  const stage = mkdtempSync(join(tmpdir(), 'dsh-workbench-tui-graph-'));
  try {
    mkdirSync(join(stage, 'patches'));
    copyFileSync(join(root, contract.components.tui.compatibilityPatch!.path), join(stage, 'patches/tui-rename.patch'));
    writeFileSync(join(stage, 'package.json'), JSON.stringify({
      name: 'dsh-workbench-tui-graph-check', private: true, version: '0.0.0',
      dependencies: {
        [contract.components.dsh.package.name]: contract.components.dsh.package.version,
        [contract.components.tui.package.name]: contract.components.tui.package.version,
      },
    }));
    const installArgs = ['install', '--lockfile-only', '--strict-peer-dependencies',
      '--ignore-scripts', '--reporter', 'append-only'];
    writeFileSync(join(stage, 'pnpm-workspace.yaml'), rendered.stdout.slice(0, split));
    const baseline = run('pnpm', installArgs, stage);
    assert.notEqual(baseline.status, 0, 'the uncorrected graph unexpectedly resolved');
    assert.equal(errorCode(baseline), '[ERR_PNPM_PEER_DEP_ISSUES]');

    writeFileSync(join(stage, 'pnpm-workspace.yaml'), rendered.stdout);
    const corrected = run('pnpm', installArgs, stage);
    assert.equal(corrected.status, 0, errorCode(corrected));
    const frozen = run('pnpm', ['install', '--frozen-lockfile', '--strict-peer-dependencies',
      '--ignore-scripts', '--reporter', 'append-only'], stage);
    assert.equal(frozen.status, 0, errorCode(frozen));

    const lock = readFileSync(join(stage, 'pnpm-lock.yaml'), 'utf8');
    assert.ok(lock.includes(contract.components.tui.compatibilityPatch!.sha256), 'TUI patch digest missing');
    for (const component of [contract.components.dsh, contract.components.tui]) {
      assert.ok(lock.includes(component.package.integrity), `${component.package.name} integrity missing`);
    }
    const packages = lock.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0];
    assert.ok(packages, 'lockfile packages section missing');
    assert.deepEqual([...packages.matchAll(/^  dsh-working-activity@([^:\s]+):/gm)].map(match => match[1]),
      [contract.components.tui.peerOverrides!.workingActivity]);
    assert.deepEqual([...packages.matchAll(/^  react@([^:\s]+):/gm)].map(match => match[1]),
      [contract.components.tui.peerOverrides!.react]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test('reviewed TUI profile lock installs without resolving a new graph', { timeout: 600_000 }, async () => {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-workbench-tui-profile-'));
  try {
    mkdirSync(join(stage, 'patches'));
    copyFileSync(join(root, contract.components.tui.compatibilityPatch!.path), join(stage, 'patches/tui-rename.patch'));
    writeFileSync(join(stage, 'package.json'), JSON.stringify({
      name: 'dsh-profile-dsh-tui',
      private: true,
      dependencies: {
        [contract.components.tui.package.name]: contract.components.tui.package.version,
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', contract.components.tui.package.name],
        },
      },
    }));
    const rendered = run(process.execPath, [renderer], root);
    assert.equal(rendered.status, 0, rendered.stderr);
    writeFileSync(join(stage, 'pnpm-workspace.yaml'), rendered.stdout);
    copyFileSync(profileLock, join(stage, 'pnpm-lock.yaml'));
    const frozen = run('pnpm', ['install', '--frozen-lockfile', '--strict-peer-dependencies',
      '--ignore-scripts', '--reporter', 'append-only'], stage);
    assert.equal(frozen.status, 0, errorCode(frozen));
    const tuiRoot = join(stage, 'node_modules', contract.components.tui.package.name);
    const patchedPlugin = readFileSync(join(tuiRoot, 'lib/types/dsh-adapter/plugin.js'), 'utf8');
    assert.match(patchedPlugin,
      /ctx\.on\('approval\/request', \(req, next\) => approvalStore\.park\(req\)\.catch\(\(\) => next\(\)\), \{ global: true, prepend: true \}\);/,
      'installed TUI approval handler must receive agent-scoped dispatch before other global listeners');
    const { ApprovalStore } = await import(pathToFileURL(join(tuiRoot, 'lib/types/dsh-adapter/approvals.js')).href);
    const approvalStore = new ApprovalStore({ mode: 'legacy', slices: [] });
    const sharedCallId = 'shared-low-entropy-call-id';
    const request = (agentId: string) => ({
      agent: {
        id: agentId,
        session: { events: [{ type: 'tool/call', data: { callId: sharedCallId, arguments: '{"command":"true"}' } }] },
      },
      callId: sharedCallId,
      toolName: 'bash',
      signal: new AbortController().signal,
    });
    const firstResult = approvalStore.park(request('agent-first'));
    const secondResult = approvalStore.park(request('agent-second'));
    assert.deepEqual(approvalStore.pendingAgentIds(), ['agent-first', 'agent-second']);
    assert.equal(approvalStore.getSnapshot()?.agentId, 'agent-first');
    approvalStore.decide('allowed-once');
    assert.equal(await firstResult, 'allowed-once');
    assert.equal(approvalStore.getSnapshot()?.agentId, 'agent-second');
    approvalStore.decide('rejected');
    assert.equal(await secondResult, 'rejected');
    assert.deepEqual(approvalStore.pendingAgentIds(), []);
    const lock = readFileSync(join(stage, 'pnpm-lock.yaml'), 'utf8');
    assert.ok(lock.includes(contract.components.tui.package.integrity), 'TUI integrity missing');
    assert.ok(lock.includes(contract.components.tui.compatibilityPatch!.sha256), 'TUI patch digest missing');
    const packages = lock.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0];
    assert.ok(packages, 'lockfile packages section missing');
    assert.ok(packages.includes(`  dsh-working-activity@${contract.components.tui.peerOverrides!.workingActivity}:`));
    assert.ok(packages.includes(`  react@${contract.components.tui.peerOverrides!.react}:`));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
