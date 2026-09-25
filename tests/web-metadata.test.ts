import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
    for (const dir of ['scripts', 'src', 'compatibility', 'web']) mkdirSync(join(stage, dir));
    for (const file of ['scripts/web-metadata.mjs', 'src/web-metadata.ts',
      'compatibility/workbench.json', 'web/package.json', 'pnpm-workspace.yaml']) {
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
