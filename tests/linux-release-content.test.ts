import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectPeerBundle, reviewedInstallerSourcePaths, validateFrozenProfileManifest,
  validatePeerSemanticRecord } from '../src/linux-release-content.ts';
import { WORKBENCH_PROFILE_PATCH } from '../src/combined-profile.ts';
import type { WorkbenchContract } from '../src/contract-types.ts';

const source = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(join(source, 'compatibility/workbench.json'), 'utf8')) as WorkbenchContract;

function bundle(names: string[], prepare?: (root: string) => void): Buffer {
  const root = mkdtempSync(join(tmpdir(), 'dsh-workbench-peer-bundle-'));
  try {
    for (const name of new Set(names)) writeFileSync(join(root, name), `archive:${name}`);
    prepare?.(root);
    const archive = join(root, 'bundle.tar.gz');
    const packed = spawnSync('tar', ['-czf', archive, ...names], { cwd: root });
    assert.equal(packed.status, 0);
    return readFileSync(archive);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('peer bundle accepts a complete regular-file archive without extraction', () => {
  const members = inspectPeerBundle(bundle(['a.tgz', 'b.tgz']));
  assert.deepEqual([...members.keys()], ['a.tgz', 'b.tgz']);
  assert.equal(members.get('a.tgz')?.toString(), 'archive:a.tgz');
});

test('peer bundle refuses duplicate members and symbolic links', () => {
  assert.throws(() => inspectPeerBundle(bundle(['a.tgz', 'a.tgz'])), /unsafe or duplicate/);
  assert.throws(() => inspectPeerBundle(bundle(['a.tgz', 'link.tgz'], root => {
    rmSync(join(root, 'link.tgz'));
    symlinkSync('a.tgz', join(root, 'link.tgz'));
  })), /unsafe or duplicate/);
});

test('peer bundle refuses invalid compression', () => {
  assert.throws(() => inspectPeerBundle(Buffer.from('invalid')), /cannot be decompressed/);
});

test('frozen profile rejects lifecycle code and changed Web/TUI bundles', () => {
  const dependencies = new Map([['@deepseek-ai/dsh', 'file:artifacts/dsh.tgz']]);
  const profile = {
    name: 'dsh-profile-workbench', private: true,
    dependencies: Object.fromEntries(dependencies),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
      contract.components.tui.package.name] } },
  };
  assert.doesNotThrow(() => validateFrozenProfileManifest(profile, dependencies, contract));
  assert.throws(() => validateFrozenProfileManifest({ ...profile, scripts: {
    preinstall: 'run-unreviewed-code',
  } }, dependencies, contract), /reviewed configuration/);
  assert.throws(() => validateFrozenProfileManifest({ ...profile,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, dependencies, contract), /reviewed configuration/);
});

test('semantic peer record requires one pinned identity per non-registry package', () => {
  const digest = 'a'.repeat(64);
  const kit = {
    workspace_artifacts: {
      '@deepseek-ai/alpha': { version: '1.0.0', artifact_sha256: digest },
      '@deepseek-ai/beta': { version: '1.0.0', artifact_sha256: digest },
      '@deepseek-ai/native': { version: '1.0.0', artifact_sha256: digest },
    },
    registry_workspace_artifacts: { '@deepseek-ai/native': { integrity: 'sha512-fixture' } },
  } as unknown as Parameters<typeof validatePeerSemanticRecord>[1];
  const rows = [
    { name: '@deepseek-ai/alpha', version: '1.0.0', semanticSha256: digest },
    { name: '@deepseek-ai/beta', version: '1.0.0', semanticSha256: digest },
  ];
  assert.equal(validatePeerSemanticRecord(rows, kit).size, 2);
  for (const invalid of [rows.slice(0, 1), [rows[0], rows[0]],
    [{ ...rows[0], semanticSha256: 'bad' }, rows[1]],
    [rows[0], { ...rows[1], version: '2.0.0' }]]) {
    assert.throws(() => validatePeerSemanticRecord(invalid, kit), /semantic identity set/);
  }
});

test('shipped installer sources import only other shipped installer sources', () => {
  const shipped = new Set<string>(reviewedInstallerSourcePaths);
  const repo = fileURLToPath(new URL('..', import.meta.url));
  for (const path of reviewedInstallerSourcePaths) {
    const source = readFileSync(join(repo, path), 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
      const target = join(path, '..', match[1]);
      assert.ok(shipped.has(target), `${path} imports ${target}, which the release does not ship`);
    }
  }
});

test('the release content check expects the staged profile patch bytes', () => {
  const source = readFileSync(new URL('../src/linux-release-content.ts', import.meta.url), 'utf8');
  const literal = source.match(/\['profile\/cordis\.patch\.yml', ("[^"]*"\n\s*\+ '[^']*')\]/);
  assert.ok(literal, 'profile patch expectation not found');
  assert.equal(new Function(`return ${literal[1]};`)(), WORKBENCH_PROFILE_PATCH);
});
