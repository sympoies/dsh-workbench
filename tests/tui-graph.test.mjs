import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(fileURLToPath(new URL('../compatibility/workbench.json', import.meta.url)), 'utf8'));
const renderer = fileURLToPath(new URL('../scripts/tui-compat.mjs', import.meta.url));
const profileLock = fileURLToPath(new URL('../compatibility/tui-profile/pnpm-lock.yaml', import.meta.url));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300_000 });
  assert.equal(result.error, undefined, `${command} could not start`);
  return result;
}

function errorCode(result) {
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
    for (const component of [contract.components.dsh, contract.components.tui]) {
      assert.ok(lock.includes(component.package.integrity), `${component.package.name} integrity missing`);
    }
    const packages = lock.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0];
    assert.ok(packages, 'lockfile packages section missing');
    assert.deepEqual([...packages.matchAll(/^  dsh-working-activity@([^:\s]+):/gm)].map(match => match[1]),
      [contract.components.tui.peerOverrides.workingActivity]);
    assert.deepEqual([...packages.matchAll(/^  react@([^:\s]+):/gm)].map(match => match[1]),
      [contract.components.tui.peerOverrides.react]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test('reviewed TUI profile lock installs without resolving a new graph', { timeout: 600_000 }, () => {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-workbench-tui-profile-'));
  try {
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
    const lock = readFileSync(join(stage, 'pnpm-lock.yaml'), 'utf8');
    assert.ok(lock.includes(contract.components.tui.package.integrity), 'TUI integrity missing');
    const packages = lock.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0];
    assert.ok(packages, 'lockfile packages section missing');
    assert.ok(packages.includes(`  dsh-working-activity@${contract.components.tui.peerOverrides.workingActivity}:`));
    assert.ok(packages.includes(`  react@${contract.components.tui.peerOverrides.react}:`));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
