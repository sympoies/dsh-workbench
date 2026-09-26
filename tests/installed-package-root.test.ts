import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installedPackageRoot } from './installed-package-root.ts';

test('deduplicates a direct pnpm symlink and its virtual store package', () => {
  const profile = mkdtempSync(join(tmpdir(), 'workbench-package-root-'));
  try {
    const packageName = '@deepseek-ai/cordis';
    const realRoot = join(profile, 'node_modules/.pnpm/@deepseek-ai+cordis@4.0.4/node_modules', packageName);
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(join(realRoot, 'package.json'), JSON.stringify({ name: packageName, version: '4.0.4' }));
    const directRoot = join(profile, 'node_modules', packageName);
    mkdirSync(join(profile, 'node_modules/@deepseek-ai'), { recursive: true });
    symlinkSync(realRoot, directRoot, 'dir');

    assert.equal(installedPackageRoot(profile, packageName), realRoot);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('rejects two different installed copies of the requested package', () => {
  const profile = mkdtempSync(join(tmpdir(), 'workbench-package-root-'));
  try {
    const packageName = '@deepseek-ai/cordis';
    const first = join(profile, 'node_modules/.pnpm/@deepseek-ai+cordis@4.0.4/node_modules', packageName);
    const second = join(profile, 'node_modules/.pnpm/@deepseek-ai+cordis@4.1.0/node_modules', packageName);
    for (const [root, version] of [[first, '4.0.4'], [second, '4.1.0']]) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: packageName, version }));
    }

    assert.throws(() => installedPackageRoot(profile, packageName), /one installed package root/);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
