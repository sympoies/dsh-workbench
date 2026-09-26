import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { normalizePnpmLicenseReport } from '../src/license-inventory.ts';

test('creates a deterministic path-free production license inventory', () => {
  const report = {
    MIT: [
      {
        name: '@example/runtime',
        versions: ['2.0.0', '1.0.0'],
        paths: ['/opaque/install/root/node_modules/runtime'],
        license: 'MIT',
        author: 'Metadata that is not a license holder',
      },
      {
        name: '@example/runtime',
        versions: ['1.0.0'],
        paths: ['/another/install/root/node_modules/runtime'],
        license: 'MIT',
      },
    ],
    'Apache-2.0': [
      {
        name: 'sample-package',
        versions: ['3.1.4'],
        paths: ['/opaque/install/root/node_modules/sample-package'],
        license: 'Apache-2.0',
      },
    ],
  };

  const inventory = normalizePnpmLicenseReport(report);

  assert.deepEqual(inventory, {
    schemaVersion: 'dsh-workbench.dependency-license-inventory.v1',
    packageCount: 3,
    packages: [
      { name: '@example/runtime', version: '1.0.0', license: 'MIT' },
      { name: '@example/runtime', version: '2.0.0', license: 'MIT' },
      { name: 'sample-package', version: '3.1.4', license: 'Apache-2.0' },
    ],
  });
  assert.doesNotMatch(JSON.stringify(inventory), /install\/root|Metadata that is not/);
});

test('rejects entries without an explicit license identity', () => {
  assert.throws(
    () => normalizePnpmLicenseReport({ MIT: [{ name: 'sample-package', versions: ['1.0.0'] }] }),
    /license metadata/,
  );
});

test('rejects a package version assigned conflicting licenses', () => {
  assert.throws(
    () =>
      normalizePnpmLicenseReport({
        MIT: [{ name: 'sample-package', versions: ['1.0.0'], license: 'MIT' }],
        'Apache-2.0': [
          { name: 'sample-package', versions: ['1.0.0'], license: 'Apache-2.0' },
        ],
      }),
    /conflicting package licenses/,
  );
});

test('reports distinct safe CLI diagnostics for malformed JSON and invalid package groups', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-workbench-license-report-'));
  const cli = fileURLToPath(new URL('../scripts/license-inventory.ts', import.meta.url));
  const run = (content: string) => {
    const input = join(temp, 'report.json');
    writeFileSync(input, content);
    return spawnSync(process.execPath, [cli, input], { encoding: 'utf8' });
  };

  try {
    const malformedJson = run('{ definitely not json');
    const invalidGroup = run('{"MIT": "not-an-array"}');

    assert.equal(malformedJson.status, 1);
    assert.equal(invalidGroup.status, 1);
    assert.match(malformedJson.stderr, /license-inventory: malformed JSON report/);
    assert.match(invalidGroup.stderr, /license-inventory: invalid package group/);
    assert.doesNotMatch(malformedJson.stderr + invalidGroup.stderr, /report\.json|tmp|definitely|not-an-array/);
    assert.notEqual(malformedJson.stderr, invalidGroup.stderr);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
