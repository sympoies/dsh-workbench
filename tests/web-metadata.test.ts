import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { WorkbenchContract } from '../src/contract-types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

test('Web manifest and DSH catalog are derived from the single Workbench contract', () => {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-workbench-web-metadata-'));
  try {
    for (const dir of ['scripts', 'src', 'compatibility', 'web/src']) mkdirSync(join(stage, dir), { recursive: true });
    for (const file of ['scripts/web-metadata.mjs', 'src/web-metadata.ts',
      'compatibility/workbench.json', 'web/package.json', 'web/src/identity.ts', 'pnpm-workspace.yaml']) {
      copyFileSync(join(root, file), join(stage, file));
    }
    const run = (command: 'check' | 'write') => spawnSync(process.execPath, [join(stage, 'scripts/web-metadata.mjs'), command],
      { encoding: 'utf8' });
    const valid = run('check');
    assert.equal(valid.status, 0, valid.stderr);
    const path = join(stage, 'compatibility/workbench.json');
    const changed = JSON.parse(readFileSync(path, 'utf8')) as WorkbenchContract;
    const releaseVersion = changed.release.version;
    changed.release.version = '0.1.0-rc.99';
    writeFileSync(path, JSON.stringify(changed));
    const drift = run('check');
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /version differs/);
    changed.release.version = releaseVersion;
    changed.components.dsh.package.version = '0.1.7-rc.99';
    writeFileSync(path, JSON.stringify(changed));
    const catalogDrift = run('check');
    assert.notEqual(catalogDrift.status, 0);
    assert.match(catalogDrift.stderr, /catalog differs/);
    changed.release.version = '0.1.0-rc.99';
    writeFileSync(path, JSON.stringify(changed));
    const generated = run('write');
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(JSON.parse(readFileSync(join(stage, 'web/package.json'), 'utf8')).version, changed.release.version);
    assert.match(readFileSync(join(stage, 'pnpm-workspace.yaml'), 'utf8'), /0\.1\.7-rc\.99/);
    const repaired = run('check');
    assert.equal(repaired.status, 0, repaired.stderr);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test('Web identity authenticates the immutable graph and rejects stale metadata', () => {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-workbench-web-identity-'));
  try {
    for (const dir of ['scripts', 'src', 'compatibility', 'web/src']) mkdirSync(join(stage, dir), { recursive: true });
    for (const file of ['scripts/web-metadata.mjs', 'src/web-metadata.ts',
      'compatibility/workbench.json', 'web/package.json', 'pnpm-workspace.yaml']) {
      copyFileSync(join(root, file), join(stage, file));
    }
    const run = (command: 'check' | 'write') => spawnSync(process.execPath,
      [join(stage, 'scripts/web-metadata.mjs'), command], { encoding: 'utf8' });
    assert.equal(run('write').status, 0);
    const contractPath = join(stage, 'compatibility/workbench.json');
    const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as WorkbenchContract;
    const identity = readFileSync(join(stage, 'web/src/identity.ts'), 'utf8');
    const parsed = JSON.parse(identity.slice(identity.indexOf('=') + 1, identity.lastIndexOf(' as const;')));
    const { graphDigest, ...graph } = parsed;
    assert.equal(graphDigest, `sha256:${createHash('sha256').update(JSON.stringify(graph)).digest('hex')}`);
    assert.equal(parsed.schemaVersion, 2);
    assert.equal('status' in parsed, false);
    assert.equal('acceptance' in parsed, false);
    assert.deepEqual(Object.keys(graph).sort(), ['components', 'release', 'runtime', 'schemaVersion']);
    assert.deepEqual(graph.release, contract.release);
    assert.deepEqual(graph.runtime, contract.runtime);
    assert.deepEqual(Object.keys(graph.components).sort(), Object.keys(contract.components).sort());
    for (const [name, component] of Object.entries(contract.components)) {
      assert.deepEqual(graph.components[name],
        Object.fromEntries(Object.entries(component).filter(([key]) => key !== 'status')),
        `${name} immutable fields are not completely authenticated`);
    }
    assert.match(identity, new RegExp(contract.release.version.replaceAll('.', '\\.')));
    for (const component of Object.values(contract.components)) {
      assert.ok(identity.includes(component.source.commit));
      assert.ok(identity.includes(component.package.version));
    }
    assert.equal(run('check').status, 0);
    contract.components.runtimeKit.source.commit = 'a'.repeat(40);
    writeFileSync(contractPath, JSON.stringify(contract));
    const stale = run('check');
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /identity differs/);
    assert.equal(run('write').status, 0);
    assert.equal(run('check').status, 0);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test('acceptance promotion preserves the exact Web artifact identity', () => {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-workbench-web-promotion-'));
  try {
    for (const dir of ['scripts', 'src', 'compatibility', 'web/src']) mkdirSync(join(stage, dir), { recursive: true });
    for (const file of ['scripts/web-metadata.mjs', 'src/web-metadata.ts',
      'compatibility/workbench.json', 'web/package.json', 'pnpm-workspace.yaml']) {
      copyFileSync(join(root, file), join(stage, file));
    }
    const run = () => spawnSync(process.execPath,
      [join(stage, 'scripts/web-metadata.mjs'), 'write'], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    const identityPath = join(stage, 'web/src/identity.ts');
    const candidate = readFileSync(identityPath, 'utf8');
    const path = join(stage, 'compatibility/workbench.json');
    const contract = JSON.parse(readFileSync(path, 'utf8')) as WorkbenchContract;
    contract.status = 'accepted';
    for (const component of Object.values(contract.components)) component.status = 'accepted';
    Object.values(contract.acceptance).forEach((value, index) => {
      value.status = 'passed';
      value.evidence = [{ platform: 'linux-x64', url: `https://github.com/sympoies/dsh-workbench/pull/${100 + index}` }];
    });
    writeFileSync(path, JSON.stringify(contract));
    assert.equal(run().status, 0);
    assert.equal(readFileSync(identityPath, 'utf8'), candidate,
      'Promoting the same tested graph changes Web artifact bytes');
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
