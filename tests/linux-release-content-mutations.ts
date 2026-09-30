import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { verifyLinuxReleaseContents } from '../src/linux-release-content.ts';
import type { LinuxReleaseManifest } from '../src/linux-release-manifest.ts';

const [source, manifestSha256, kitRepo] = process.argv.slice(2);
if (![source, kitRepo].every(path => path && isAbsolute(path))
  || !/^[a-f0-9]{64}$/.test(manifestSha256 ?? '')) {
  throw new Error('usage: node tests/linux-release-content-mutations.ts ROOT MANIFEST_SHA256 KIT_REPO');
}
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const parent = mkdtempSync(join(dirname(source), 'release-content-mutations-'));
const root = join(parent, 'candidate');
try {
  cpSync(source, root, { recursive: true, errorOnExist: true });
  chmodSync(root, 0o700);
  verifyLinuxReleaseContents(root, manifestSha256, kitRepo);
  const originalManifest = readFileSync(join(root, 'release-manifest.json'));
  const original = JSON.parse(originalManifest.toString('utf8')) as LinuxReleaseManifest;
  const peer = original.files.find(file => file.path.startsWith('profile/artifacts/deepseek-ai-')
    && file.path.endsWith('.tgz') && !original.archives.some(archive => archive.path === file.path));
  if (!peer) throw new Error('release fixture has no patched peer archive');
  const provider = original.archives.find(archive =>
    archive.path.startsWith('profile/artifacts/sympoies-dsh-llm-codex-subscription-'));
  if (!provider) throw new Error('release fixture has no provider archive');
  const changes: Array<{ label: string; path: string; mutate: (bytes: Buffer) => Buffer; error: RegExp }> = [
    { label: 'reviewed contract source', path: 'compatibility/workbench.json',
      mutate: bytes => Buffer.concat([bytes, Buffer.from(' ')]),
      error: /reviewed builder source/ },
    { label: 'reviewed Web record source', path: 'compatibility/web-artifact.json',
      mutate: bytes => Buffer.concat([bytes, Buffer.from(' ')]),
      error: /reviewed builder source/ },
    { label: 'reviewed installer source', path: 'installer/src/contract.ts',
      mutate: bytes => Buffer.concat([bytes, Buffer.from('\n// changed installer\n')]),
      error: /reviewed builder source/ },
    { label: 'profile lifecycle', path: 'profile/package.json', mutate: bytes => {
      const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      value.scripts = { preinstall: 'unreviewed-code' };
      return Buffer.from(`${JSON.stringify(value)}\n`);
    }, error: /frozen profile manifest differs/ },
    { label: 'workspace drift', path: 'profile/pnpm-workspace.yaml',
      mutate: bytes => Buffer.concat([bytes, Buffer.from('# changed resolution\n')]),
      error: /workspace or lock differs/ },
    { label: 'lockfile drift', path: 'profile/pnpm-lock.yaml',
      mutate: bytes => Buffer.concat([bytes, Buffer.from('# changed dependency resolution\n')]),
      error: /workspace or lock differs/ },
    { label: 'runtime-kit proof', path: 'runtime-kit/source-build-proof.json', mutate: bytes => {
      const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      value.packageCanonicalSha256 = 'a'.repeat(64);
      return Buffer.from(`${JSON.stringify(value)}\n`);
    }, error: /source-build proof/ },
    { label: 'provider archive', path: provider.path,
      mutate: bytes => Buffer.concat([bytes, Buffer.from('changed')]),
      error: /official component archive integrity differs from contract/ },
    { label: 'peer closure', path: peer.path,
      mutate: bytes => Buffer.concat([bytes, Buffer.from('changed')]),
      error: /peer closure canonical digest|peer archive differs/ },
  ];
  for (const change of changes) {
    const path = join(root, change.path);
    const before = readFileSync(path);
    const modified = change.mutate(before);
    writeFileSync(path, modified);
    const manifest = structuredClone(original);
    const file = manifest.files.find(row => row.path === change.path);
    if (!file) throw new Error('mutation target is not indexed');
    file.size = lstatSync(path).size;
    file.rawSha256 = sha256(modified);
    // Keep the envelope consistent so the content check, not the file index, judges an archive.
    const archive = manifest.archives.find(row => row.path === change.path);
    if (archive) archive.rawSha256 = file.rawSha256;
    if (change.path === manifest.contractPath) manifest.contractRawSha256 = file.rawSha256;
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    writeFileSync(join(root, 'release-manifest.json'), manifestBytes);
    assert.throws(() => verifyLinuxReleaseContents(root, sha256(manifestBytes), kitRepo),
      change.error, change.label);
    writeFileSync(path, before);
    writeFileSync(join(root, 'release-manifest.json'), originalManifest);
    process.stdout.write(`rejected: ${change.label}\n`);
  }
} finally { rmSync(parent, { recursive: true, force: true }); }
