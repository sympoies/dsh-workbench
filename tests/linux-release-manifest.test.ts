import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyLinuxReleaseEnvelope, type LinuxReleaseFile, type LinuxReleaseManifest, type LinuxReleaseRole } from '../src/linux-release-manifest.ts';
import { workbenchIdentity } from '../web/src/identity.ts';

const source = fileURLToPath(new URL('..', import.meta.url));
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const roles: Record<string, LinuxReleaseRole> = {
  compatibility: 'contract', installer: 'installer', profile: 'profile',
  'runtime-kit': 'runtimeKit', nils: 'nilsTool', notices: 'notices',
  'license-inventory': 'licenseInventory',
};

function fixture(): { root: string; manifest: LinuxReleaseManifest; write: () => string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-workbench-release-manifest-'));
  const add = (path: string, bytes: Buffer | string, mode = 0o644) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes, { mode });
  };
  for (const path of ['compatibility/workbench.json', 'compatibility/web-artifact.json',
    'compatibility/patches/tui-rename.patch']) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(source, path), join(root, path));
  }
  for (const [from, to] of [
    ['scripts/contract.mjs', 'installer/scripts/contract.mjs'],
    ['src/contract.ts', 'installer/src/contract.ts'],
    ['src/contract-types.ts', 'installer/src/contract-types.ts'],
    ['src/linux-release-manifest.ts', 'installer/src/linux-release-manifest.ts'],
  ]) {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    copyFileSync(join(source, from), join(root, to));
  }
  add('installer/package.json', '{"type":"module"}\n');
  const contract = JSON.parse(readFileSync(join(root, 'compatibility/workbench.json'), 'utf8'));
  // Unit fixtures model an accepted payload; the tracked candidate remains pending.
  contract.status = 'accepted';
  for (const component of Object.values(contract.components) as Array<{ status: string }>) {
    component.status = 'accepted';
  }
  for (const [index, gate] of (Object.values(contract.acceptance) as Array<{
    status: string; evidence: Array<{ platform: string; url: string }> }>).entries()) {
    gate.status = 'passed';
    if (gate.evidence.length === 0) {
      gate.evidence = [{ platform: 'linux-x64', url: `https://github.com/sympoies/dsh-workbench/pull/${901 + index}` }];
    }
  }
  writeFileSync(join(root, 'compatibility/workbench.json'), `${JSON.stringify(contract)}\n`);
  const dshPath = `profile/artifacts/${contract.components.dsh.package.name.slice(1).replace('/', '-')}-${contract.components.dsh.package.version}.tgz`;
  const tuiPath = `profile/artifacts/${contract.components.tui.package.name.slice(1).replace('/', '-')}-${contract.components.tui.package.version}.tgz`;
  const providerPath = `profile/artifacts/${contract.components.codexSubscription.package.name.slice(1).replace('/', '-')}-${contract.components.codexSubscription.package.version}.tgz`;
  const webPath = `profile/artifacts/sympoies-dsh-workbench-web-${contract.release.version}.tgz`;
  const peerPath = 'profile/artifacts/peer-closure.tgz';
  for (const path of [dshPath, tuiPath, providerPath, webPath, peerPath]) add(path, `${path} archive bytes`);
  add('profile/package.json', '{"name":"dsh-profile-workbench","private":true}\n');
  add('profile/pnpm-workspace.yaml', "packages: []\n");
  add('profile/pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  add('runtime-kit/package.tgz', 'kit archive bytes');
  add('nils/nils-cli-v1.29.0-x86_64-unknown-linux-gnu.tar.gz', 'nils archive bytes');
  for (const name of ['agent-hook', 'agent-docs', 'agent-session', 'forge-cli', 'git-cli',
    'review-specialists', 'semantic-commit']) {
    add(`nils/bin/${name}`, `#!/bin/sh\n# ${name}\n`, 0o755);
  }
  add('notices/LICENSE', 'MIT\n');
  add('license-inventory/production.json', '{}\n');
  const manifest: LinuxReleaseManifest = {
    schemaVersion: 'dsh-workbench.linux-release.v1', releaseVersion: contract.release.version,
    platform: 'linux-x64', contractPath: 'compatibility/workbench.json',
    contractRawSha256: '', graphSha256: workbenchIdentity.graphDigest.slice(7),
    builderSource: { repository: 'https://github.com/sympoies/dsh-workbench',
      commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    files: [], archives: [],
    runtimeKit: { sourceCommit: contract.components.runtimeKit.source.commit,
      sourceTree: contract.components.runtimeKit.source.tree,
      packagePath: 'runtime-kit/package.tgz', packageRawSha256: '' },
    nilsRelease: { version: '1.29.0', archivePath: 'nils/nils-cli-v1.29.0-x86_64-unknown-linux-gnu.tar.gz', archiveRawSha256: '',
      toolPaths: ['agent-hook', 'agent-docs', 'agent-session', 'forge-cli', 'git-cli',
        'review-specialists', 'semantic-commit']
        .map(name => `nils/bin/${name}`) },
  };
  const write = () => {
    const nilsArchive = readFileSync(join(root, manifest.nilsRelease.archivePath));
    add('runtime-kit/compatibility/nils-cli.json', `${JSON.stringify({
      schema_version: 'dsh-runtime-kit.nils-compatibility.v1', status: 'released',
      release: { source_revision: 'v1.29.0', platform: 'x86_64-unknown-linux-gnu',
        archive: { name: 'nils-cli-v1.29.0-x86_64-unknown-linux-gnu.tar.gz', sha256: sha256(nilsArchive) },
        artifacts: Object.fromEntries(manifest.nilsRelease.toolPaths.map(path => [path.split('/').at(-1),
          { sha256: sha256(readFileSync(join(root, path))) }])) },
    })}\n`);
    const paths = [
      'compatibility/workbench.json', 'compatibility/web-artifact.json',
      'compatibility/patches/tui-rename.patch', 'installer/package.json',
      'installer/scripts/contract.mjs', 'installer/src/contract.ts',
      'installer/src/contract-types.ts', 'installer/src/linux-release-manifest.ts',
      dshPath, tuiPath, providerPath, webPath, peerPath,
      'profile/package.json', 'profile/pnpm-workspace.yaml', 'profile/pnpm-lock.yaml',
      'runtime-kit/package.tgz',
      'runtime-kit/compatibility/nils-cli.json', manifest.nilsRelease.archivePath,
      ...manifest.nilsRelease.toolPaths, 'notices/LICENSE', 'license-inventory/production.json',
    ].sort();
    manifest.files = paths.map(path => {
      const stat = lstatSync(join(root, path));
      return { path, role: roles[path.split('/')[0]], size: stat.size,
        mode: `0${(stat.mode & 0o777).toString(8)}` as LinuxReleaseFile['mode'],
        rawSha256: sha256(readFileSync(join(root, path))) };
    });
    manifest.contractRawSha256 = manifest.files.find(file => file.path === manifest.contractPath)!.rawSha256;
    manifest.runtimeKit.packageRawSha256 = manifest.files.find(file => file.path === 'runtime-kit/package.tgz')!.rawSha256;
    manifest.nilsRelease.archiveRawSha256 = manifest.files.find(file => file.path === manifest.nilsRelease.archivePath)!.rawSha256;
    const webRecord = JSON.parse(readFileSync(join(root, 'compatibility/web-artifact.json'), 'utf8'));
    manifest.archives = [
      ...[dshPath, tuiPath, providerPath, peerPath].map(path => ({ path,
        rawSha256: manifest.files.find(file => file.path === path)!.rawSha256,
        canonicalSha256: 'c'.repeat(64) })),
      { path: webPath, rawSha256: manifest.files.find(file => file.path === webPath)!.rawSha256,
        canonicalSha256: webRecord.artifactSha256 },
    ];
    const bytes = `${JSON.stringify(manifest)}\n`;
    writeFileSync(join(root, 'release-manifest.json'), bytes);
    return sha256(bytes);
  };
  return { root, manifest, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('accepted Linux release verifies an external manifest digest and closed file index', () => {
  const release = fixture();
  try {
    const digest = release.write();
    assert.equal(verifyLinuxReleaseEnvelope(release.root, digest).releaseVersion, release.manifest.releaseVersion);
    assert.throws(() => verifyLinuxReleaseEnvelope(release.root, '0'.repeat(64)), /manifest digest mismatch/);
  } finally { release.cleanup(); }
});

test('trusted verifier checks a detached payload and refuses a replaced bundled verifier', () => {
  const release = fixture();
  try {
    const digest = release.write();
    assert.equal(verifyLinuxReleaseEnvelope(release.root, digest).platform, 'linux-x64');
    writeFileSync(join(release.root, 'installer/src/linux-release-manifest.ts'),
      'export const verifyLinuxReleaseEnvelope = () => ({ platform: "linux-x64" });\n');
    assert.throws(() => verifyLinuxReleaseEnvelope(release.root, digest), /indexed file differs/);
  } finally { release.cleanup(); }
});

test('release verification refuses changed bytes, extra files, and symlinks', () => {
  for (const mutation of [
    (root: string) => writeFileSync(join(root, 'profile/artifacts/peer-closure.tgz'), 'changed'),
    (root: string) => writeFileSync(join(root, 'profile/unindexed'), 'extra'),
    (root: string) => symlinkSync('/tmp', join(root, 'profile/link')),
  ]) {
    const release = fixture();
    try {
      const digest = release.write();
      mutation(release.root);
      assert.throws(() => verifyLinuxReleaseEnvelope(release.root, digest), /LINUX_RELEASE_INVALID/);
    } finally { release.cleanup(); }
  }
});

test('release verification refuses an otherwise indexed candidate contract', () => {
  const release = fixture();
  try {
    const path = join(release.root, 'compatibility/workbench.json');
    const contract = JSON.parse(readFileSync(path, 'utf8'));
    contract.status = 'candidate';
    writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`);
    const digest = release.write();
    assert.throws(() => verifyLinuxReleaseEnvelope(release.root, digest), /contract is not accepted/);
  } finally { release.cleanup(); }
});

test('release verification refuses traversal, role drift, and unlisted manifest fields', () => {
  for (const change of [
    (manifest: LinuxReleaseManifest) => { manifest.files[0].path = '../escape'; },
    (manifest: LinuxReleaseManifest) => { manifest.files[0].role = 'profile'; },
    (manifest: LinuxReleaseManifest) => { (manifest as unknown as Record<string, unknown>).extra = true; },
  ]) {
    const release = fixture();
    try {
      release.write();
      change(release.manifest);
      const bytes = `${JSON.stringify(release.manifest)}\n`;
      writeFileSync(join(release.root, 'release-manifest.json'), bytes);
      assert.throws(() => verifyLinuxReleaseEnvelope(release.root, sha256(bytes)), /LINUX_RELEASE_INVALID/);
    } finally { release.cleanup(); }
  }
});

test('release verification refuses rewritten Web or nils identities under a new manifest digest', () => {
  for (const change of [
    (manifest: LinuxReleaseManifest) => {
      manifest.archives.find(row => row.path.includes('sympoies-dsh-workbench-web-'))!.canonicalSha256 = 'a'.repeat(64);
    },
    (manifest: LinuxReleaseManifest) => { manifest.nilsRelease.version = '1.29.1'; },
  ]) {
    const release = fixture();
    try {
      release.write();
      change(release.manifest);
      const bytes = `${JSON.stringify(release.manifest)}\n`;
      writeFileSync(join(release.root, 'release-manifest.json'), bytes);
      assert.throws(() => verifyLinuxReleaseEnvelope(release.root, sha256(bytes)), /LINUX_RELEASE_INVALID/);
    } finally { release.cleanup(); }
  }
});

test('release verification refuses two indexed payload paths sharing a hard link', () => {
  const release = fixture();
  try {
    unlinkSync(join(release.root, 'notices/LICENSE'));
    linkSync(join(release.root, 'installer/package.json'), join(release.root, 'notices/LICENSE'));
    const digest = release.write();
    assert.throws(() => verifyLinuxReleaseEnvelope(release.root, digest), /hard link/);
  } finally { release.cleanup(); }
});

test('release verification refuses a manifest hard-linked outside the payload', () => {
  const release = fixture();
  const outside = join(tmpdir(), `dsh-workbench-outside-${process.pid}-${Date.now()}`);
  try {
    const digest = release.write();
    linkSync(join(release.root, 'release-manifest.json'), outside);
    assert.throws(() => verifyLinuxReleaseEnvelope(release.root, digest), /unsafe metadata/);
  } finally {
    rmSync(outside, { force: true });
    release.cleanup();
  }
});

test('release verification refuses a payload root accessible to other users', () => {
  const release = fixture();
  try {
    const digest = release.write();
    chmodSync(release.root, 0o755);
    assert.throws(() => verifyLinuxReleaseEnvelope(release.root, digest), /private/);
  } finally { release.cleanup(); }
});

test('release verification refuses setuid permission bits on an indexed executable', () => {
  const release = fixture();
  try {
    const digest = release.write();
    chmodSync(join(release.root, 'nils/bin/agent-hook'), 0o4755);
    assert.throws(() => verifyLinuxReleaseEnvelope(release.root, digest), /file size or mode|indexed file differs/);
  } finally { release.cleanup(); }
});

test('release verification refuses omitted required archive or frozen profile classes', () => {
  for (const omitted of ['deepseek-ai-dsh-', 'deepseek-harness-tui-dsh-tui-',
    'sympoies-dsh-llm-codex-subscription-', 'sympoies-dsh-workbench-web-',
    'peer-closure.tgz', 'profile/pnpm-lock.yaml', 'profile/pnpm-workspace.yaml', 'profile/package.json']) {
    const release = fixture();
    try {
      release.write();
      const file = release.manifest.files.find(row => row.path.includes(omitted))!;
      release.manifest.files = release.manifest.files.filter(row => row !== file);
      release.manifest.archives = release.manifest.archives.filter(row => row.path !== file.path);
      unlinkSync(join(release.root, file.path));
      const bytes = `${JSON.stringify(release.manifest)}\n`;
      writeFileSync(join(release.root, 'release-manifest.json'), bytes);
      assert.throws(() => verifyLinuxReleaseEnvelope(release.root, sha256(bytes)), /LINUX_RELEASE_INVALID/);
    } finally { release.cleanup(); }
  }
});
