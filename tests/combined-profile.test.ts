import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { stageCombinedProfile, stageCombinedProfileFromPinnedKit } from '../src/combined-profile.ts';
import { inspectPeerArtifact } from '../src/package-artifact.ts';

const revision = '46a7f68b0922371ce7144b668b90e377d8e799f4';
const releaseVersion = (JSON.parse(readFileSync(new URL('../compatibility/workbench.json', import.meta.url), 'utf8')) as
  { release: { version: string } }).release.version;

function tarEntry(path: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(path);
  header.write('0000644\0', 100);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header[156] = 48;
  const padding = Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length);
  return Buffer.concat([header, bytes, padding]);
}

function archive(name: string, version: string, clientCode?: string): Buffer {
  const entries = [tarEntry('package/package.json', Buffer.from(JSON.stringify({ name, version })))];
  if (clientCode !== undefined) entries.push(tarEntry('package/lib/client.js', Buffer.from(clientCode)));
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-workbench-combined-'));
  const artifacts = join(root, 'input');
  mkdirSync(artifacts);
  const tuiArchive = join(artifacts, 'tui.tgz');
  const tuiBytes = Buffer.from('reviewed TUI archive fixture');
  writeFileSync(tuiArchive, tuiBytes);
  const webArchive = join(artifacts, 'web.tgz');
  writeFileSync(webArchive, archive('@sympoies/dsh-workbench-web', releaseVersion,
    'export const marker = 1;'));
  const webDigest = inspectPeerArtifact(readFileSync(webArchive)).artifactSha256;
  const tuiIntegrity = `sha512-${createHash('sha512').update(tuiBytes).digest('base64')}`;
  const entries = [
    ['@deepseek-ai/cordis', '4.0.4'],
    ['@deepseek-ai/dsh-sandbox', '0.1.7-rc.1'],
  ] as const;
  const packages = entries.map(([name, version], index) => {
    const path = join(artifacts, `package-${index}.tgz`);
    const bytes = archive(name, version);
    writeFileSync(path, bytes);
    return {
      name, version, path,
      tarball_sha256: createHash('sha256').update(bytes).digest('hex'),
      artifact_sha256: inspectPeerArtifact(bytes).artifactSha256,
    };
  });
  const receipt = {
    schema_version: 'dsh-runtime-kit.dsh-peer-pack.v1',
    ok: true,
    data: {
      channel: 'pinned', revision, patch_state: 'patched',
      patch_id: 'native-execution-boundaries-v5',
      upstream_checkout_clean: false,
      packages,
    },
  };
  const kitManifest = {
    schema_version: 'dsh-runtime-kit.dsh-compatibility.v1',
    repository: 'https://github.com/deepseek-ai/deepseek-harness',
    validated_releases: { '0.1.7-rc.1': { revision } },
    public_packages: Object.fromEntries(entries.map(([name]) => [name, {}])),
    workspace_artifacts: Object.fromEntries(packages.map(row =>
      [row.name, { version: row.version, artifact_sha256: row.artifact_sha256 }])),
    patched_workspace_artifacts: {
      '@deepseek-ai/dsh-sandbox': packages[1].artifact_sha256,
    },
  };
  return { root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest };
}

test('stages the native Web plugin in the same governed workbench profile', () => {
  const { root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const profile = join(root, 'profile');
    stageCombinedProfile({ profile, receipt, kitManifest, tuiArchive, webArchive }, tuiIntegrity, webDigest);
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-harness-tui/dsh-tui',
    ]);
    assert.equal(manifest.dependencies['@sympoies/dsh-workbench-web'],
      `file:artifacts/sympoies-dsh-workbench-web-${releaseVersion}.tgz`);
    assert.match(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'),
      /name: '@sympoies\/dsh-workbench-web'/);
    assert.deepEqual(readFileSync(join(profile, `artifacts/sympoies-dsh-workbench-web-${releaseVersion}.tgz`)),
      readFileSync(webArchive));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects altered Web code under the same package name and version', () => {
  const { root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const profile = join(root, 'profile');
    writeFileSync(webArchive, archive('@sympoies/dsh-workbench-web', releaseVersion,
      'export const marker = 2;'));
    assert.throws(() => stageCombinedProfile({ profile, receipt, kitManifest, tuiArchive, webArchive },
      tuiIntegrity, webDigest), /Web archive digest/);
    assert.equal(existsSync(profile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stages a portable profile from the authenticated runtime-kit patched receipt', () => {
  const { root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const profile = join(root, 'profile');
    stageCombinedProfile({ profile, receipt, kitManifest, tuiArchive, webArchive }, tuiIntegrity, webDigest);
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-harness-tui/dsh-tui',
    ]);
    assert.equal(manifest.dependencies['@sympoies/dsh-runtime-kit'], undefined);
    assert.equal(manifest.dependencies['@deepseek-ai/dsh-sandbox'],
      'file:artifacts/deepseek-ai-dsh-sandbox-0.1.7-rc.1.tgz');
    assert.equal(manifest.dependencies['@deepseek-harness-tui/dsh-tui'],
      'file:artifacts/deepseek-harness-tui-dsh-tui-0.11.0.tgz');
    const workspace = readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(workspace, /patchedDependencies:/);
    assert.match(workspace, /'@deepseek-ai\/dsh-sandbox': 'file:artifacts\/deepseek-ai-dsh-sandbox-0\.1\.7-rc\.1\.tgz'/);
    assert.deepEqual(readFileSync(join(profile, 'artifacts/deepseek-ai-dsh-sandbox-0.1.7-rc.1.tgz')),
      readFileSync(receipt.data.packages[1].path));
    assert.match(readFileSync(join(profile, 'cordis.yml'), 'utf8'), /^\[\]\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a mixed, forged, or incomplete patched closure before creating a profile', () => {
  const { root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const profile = join(root, 'profile');
    assert.throws(() => stageCombinedProfile({ profile, receipt: {
      ...receipt, data: { ...receipt.data, packages: receipt.data.packages.slice(0, 1) },
    }, kitManifest, tuiArchive, webArchive }, tuiIntegrity, webDigest), /closure/);
    assert.throws(() => stageCombinedProfile({ profile, receipt: {
      ...receipt, data: { ...receipt.data, patch_state: 'pristine' },
    }, kitManifest, tuiArchive, webArchive }, tuiIntegrity, webDigest), /identity/);
    assert.throws(() => stageCombinedProfile({ profile, receipt: {
      ...receipt, data: { ...receipt.data, packages: [
        receipt.data.packages[0],
        { ...receipt.data.packages[1], tarball_sha256: '0'.repeat(64) },
      ] },
    }, kitManifest, tuiArchive, webArchive }, tuiIntegrity, webDigest), /digest/);
    assert.throws(() => stageCombinedProfile({ profile, receipt, kitManifest: {
      ...kitManifest, patched_workspace_artifacts: {
        '@deepseek-ai/dsh-sandbox': '0'.repeat(64),
      },
    }, tuiArchive, webArchive }, tuiIntegrity, webDigest), /digest/);
    assert.throws(() => stageCombinedProfile({ profile, receipt, kitManifest: {
      ...kitManifest, validated_releases: { '0.1.7-rc.1': { revision: '0'.repeat(40) } },
    }, tuiArchive, webArchive }, tuiIntegrity, webDigest), /revision/);
    assert.throws(() => stageCombinedProfile({ profile, receipt, kitManifest, tuiArchive, webArchive },
      'sha512-' + '0'.repeat(88)), /TUI archive integrity/);
    writeFileSync(webArchive, archive('@sympoies/dsh-workbench-web', '0.1.0-rc.4'));
    assert.throws(() => stageCombinedProfile({ profile, receipt, kitManifest, tuiArchive, webArchive },
      tuiIntegrity, webDigest), /Web archive identity/);
    assert.equal(existsSync(profile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preserves a profile directory owned by another process', () => {
  const { root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const profile = join(root, 'profile');
    mkdirSync(profile);
    writeFileSync(join(profile, 'owner.txt'), 'keep');
    assert.throws(() => stageCombinedProfile({ profile, receipt, kitManifest, tuiArchive, webArchive },
      tuiIntegrity, webDigest), /EEXIST/);
    assert.equal(readFileSync(join(profile, 'owner.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires an absolute DSH home with a profiles directory', () => {
  const { root, receipt, tuiArchive, webArchive } = fixture();
  try {
    assert.throws(() => stageCombinedProfileFromPinnedKit({
      dshHome: 'relative-home', receipt, tuiArchive, webArchive, kitRepo: root,
    }), /DSH home/);
    assert.throws(() => stageCombinedProfileFromPinnedKit({
      dshHome: root, receipt, tuiArchive, webArchive, kitRepo: root,
    }), /profiles directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
