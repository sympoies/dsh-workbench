import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { installedDependencyRoot, installedPackageRoot, installedPackageRootFrom } from './installed-package-root.ts';

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

test('resolves a peer dependency from its exact pnpm importer when variants coexist', () => {
  const profile = mkdtempSync(join(tmpdir(), 'workbench-package-root-'));
  try {
    const importerName = '@deepseek-ai/dsh-base';
    const dependencyName = '@deepseek-ai/dsh-user-approval';
    const importerRoot = join(profile,
      'node_modules/.pnpm/@deepseek-ai+dsh-base@0.1.7-rc.1/node_modules', importerName);
    const selectedDependency = join(profile,
      'node_modules/.pnpm/@deepseek-ai+dsh-user-approval@0.1.7-rc.1_peer-one/node_modules', dependencyName);
    const otherDependency = join(profile,
      'node_modules/.pnpm/@deepseek-ai+dsh-user-approval@0.1.7-rc.1_peer-two/node_modules', dependencyName);
    mkdirSync(importerRoot, { recursive: true });
    for (const [root, name] of [[importerRoot, importerName],
      [selectedDependency, dependencyName], [otherDependency, dependencyName]]) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name, version: '0.1.7-rc.1', main: 'index.js',
      }));
      if (name === dependencyName) writeFileSync(join(root, 'index.js'), 'module.exports = {};\n');
    }
    const peerScope = join(dirname(dirname(importerRoot)), '@deepseek-ai');
    mkdirSync(peerScope, { recursive: true });
    symlinkSync(selectedDependency, join(peerScope, 'dsh-user-approval'), 'dir');
    mkdirSync(join(profile, 'node_modules/@deepseek-ai'), { recursive: true });
    symlinkSync(importerRoot, join(profile, 'node_modules/@deepseek-ai/dsh-base'), 'dir');
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-fixture', private: true }));

    const resolvedImporter = installedPackageRootFrom(join(profile, 'package.json'), importerName);
    assert.equal(resolvedImporter, importerRoot);
    assert.equal(installedDependencyRoot(resolvedImporter, dependencyName), selectedDependency);
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
