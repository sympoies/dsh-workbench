import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { inspectPeerArtifact } from './package-artifact.ts';
import { readPinnedKitJson } from './pinned-kit.ts';
import { verifyLinuxReleaseEnvelope } from './linux-release-manifest.ts';
import type { WorkbenchContract } from './contract-types.ts';

type DshCompatibility = {
  schema_version: string;
  repository: string;
  validated_releases: Record<string, { revision: string }>;
  workspace_artifacts: Record<string, { version: string; artifact_sha256: string }>;
  patched_workspace_artifacts: Record<string, string>;
  registry_workspace_artifacts: Record<string, { integrity: string; platform?: string }>;
};
type NilsCompatibility = {
  schema_version: string;
  status: string;
  validated_release: string;
  release: {
    source_revision: string;
    source_commit: string;
    platform: string;
    archive: { name: string; sha256: string };
    artifacts: Record<string, { sha256: string }>;
  };
};

const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const integrity = (bytes: Buffer): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const artifactName = (name: string, version: string): string =>
  `${name.slice(1).replace('/', '-')}-${version}.tgz`;
export const reviewedCompatibilitySourcePaths = [
  'compatibility/workbench.json', 'compatibility/web-artifact.json',
  'compatibility/linux-artifacts.json', 'compatibility/patches/tui-rename.patch',
] as const;
export const reviewedInstallerSourcePaths = [
  'scripts/contract.mjs', 'src/contract.ts', 'src/contract-types.ts',
  'src/linux-release-manifest.ts', 'src/linux-release-content.ts',
  'src/pinned-kit.ts', 'src/package-artifact.ts',
] as const;
type LinuxArtifactsRecord = {
  schemaVersion: string; releaseVersion: string;
  runtimeKitPackageCanonicalSha256: string;
  profileWorkspaceRawSha256: string; profileLockRawSha256: string;
};

function builderGit(commit: string, args: string[]): Buffer {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith('GIT_')) delete environment[key];
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = '/dev/null';
  environment.GIT_OPTIONAL_LOCKS = '0';
  const result = spawnSync('/usr/bin/git', args, {
    cwd: sourceRoot, env: environment, timeout: 30_000, maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error(`reviewed builder source is unavailable: ${commit}`);
  return result.stdout;
}
const staticProfilePaths = [
  'profile/LICENSE', 'profile/THIRD_PARTY_NOTICES.md', 'profile/cordis.patch.yml',
  'profile/cordis.yml', 'profile/package.json', 'profile/pnpm-lock.yaml',
  'profile/pnpm-workspace.yaml', 'profile/patches/tui-rename.patch',
  'profile/workbench-tui/LICENSE', 'profile/workbench-tui/receipt.json',
  'profile/workbench-tui/scripts/launch-workbench-tui.ts',
  'profile/workbench-tui/src/launch-workbench.ts',
];

export function expectedProfilePaths(workbench: WorkbenchContract, kit: DshCompatibility): string[] {
  return [
    ...staticProfilePaths,
    ...Object.entries(kit.workspace_artifacts).map(([name, entry]) =>
      `profile/artifacts/${artifactName(name, entry.version)}`),
    `profile/artifacts/${artifactName(workbench.components.dsh.package.name, workbench.components.dsh.package.version)}`,
    `profile/artifacts/${artifactName(workbench.components.tui.package.name, workbench.components.tui.package.version)}`,
    `profile/artifacts/sympoies-dsh-workbench-web-${workbench.release.version}.tgz`,
  ].sort();
}

export function validateFrozenProfileManifest(profile: unknown,
  dependencies: ReadonlyMap<string, string>, workbench: WorkbenchContract): void {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('frozen profile manifest is invalid');
  }
  const value = profile as Record<string, unknown>;
  const expected = {
    name: 'dsh-profile-workbench', private: true,
    dependencies: Object.fromEntries(dependencies),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
      workbench.components.tui.package.name] } },
  };
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(expected).sort())
    || JSON.stringify(value.dsh) !== JSON.stringify(expected.dsh)
    || value.name !== expected.name || value.private !== true
    || !value.dependencies || typeof value.dependencies !== 'object'
    || Array.isArray(value.dependencies)
    || JSON.stringify(Object.entries(value.dependencies).sort())
      !== JSON.stringify([...dependencies.entries()].sort())) {
    throw new Error('frozen profile manifest differs from reviewed configuration');
  }
}

function sameJson(left: unknown, right: unknown, name: string): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`${name} differs from pinned source`);
}

function tarMember(archive: string, member: string): Buffer {
  const result = spawnSync('tar', ['-xOzf', archive, member],
    { timeout: 30_000, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0 || result.error || result.stdout.length === 0) {
    throw new Error(`required archive member is unavailable: ${member}`);
  }
  return result.stdout;
}

/** Read the deterministic peer bundle without ever extracting untrusted entries. */
export function inspectPeerBundle(archive: Buffer): Map<string, Buffer> {
  if (archive.length > 128 * 1024 * 1024) throw new Error('peer closure exceeds compressed limit');
  let tar: Buffer;
  try { tar = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 }); }
  catch { throw new Error('peer closure cannot be decompressed'); }
  const members = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const end = header.indexOf(0);
    const name = header.subarray(0, end < 0 ? 100 : Math.min(end, 100)).toString('utf8');
    const mode = header.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim();
    const size = /^[0-7]+$/.test(mode) ? Number.parseInt(mode, 8) : -1;
    const type = header[156];
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (!/^[a-z0-9][a-z0-9.-]*\.tgz$/.test(name) || members.has(name)
      || size < 1 || size > 128 * 1024 * 1024 || next > tar.length
      || (type !== 0 && type !== 48)) {
      throw new Error('peer closure has an unsafe or duplicate member');
    }
    members.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset = next;
  }
  if (members.size === 0) throw new Error('peer closure is empty');
  return members;
}

/** Authenticate archive contents and dependency closure after the envelope check. */
export function verifyLinuxReleaseContents(root: string, manifestSha256: string, kitRepo: string): {
  releaseVersion: string; peerArchives: number; profileLockSha256: string;
} {
  const manifest = verifyLinuxReleaseEnvelope(root, manifestSha256);
  const sourceTree = builderGit(manifest.builderSource.commit,
    ['rev-parse', `${manifest.builderSource.commit}^{tree}`]).toString('utf8').trim();
  if (sourceTree !== manifest.builderSource.tree) {
    throw new Error('reviewed builder source tree differs from release manifest');
  }
  const sourceBlob = (path: string): Buffer => builderGit(manifest.builderSource.commit,
    ['show', `${manifest.builderSource.commit}:${path}`]);
  for (const path of reviewedCompatibilitySourcePaths) {
    if (!readFileSync(join(root, path)).equals(sourceBlob(path))) {
      throw new Error(`release file differs from reviewed builder source: ${path}`);
    }
  }
  for (const path of reviewedInstallerSourcePaths) {
    if (!readFileSync(join(root, 'installer', path)).equals(sourceBlob(path))) {
      throw new Error(`release installer differs from reviewed builder source: ${path}`);
    }
  }
  if (!readFileSync(join(root, 'installer/package.json')).equals(Buffer.from('{"type":"module"}\n'))) {
    throw new Error('release installer differs from reviewed builder source: package.json');
  }
  const contract = JSON.parse(readFileSync(join(root, 'compatibility/workbench.json'), 'utf8')) as WorkbenchContract;
  const reviewedArtifactsBytes = sourceBlob('compatibility/linux-artifacts.json');
  if (!readFileSync(join(root, 'compatibility/linux-artifacts.json')).equals(reviewedArtifactsBytes)) {
    throw new Error('Linux artifact record differs from reviewed builder source');
  }
  const reviewedArtifacts = JSON.parse(reviewedArtifactsBytes.toString('utf8')) as LinuxArtifactsRecord;
  if (reviewedArtifacts.schemaVersion !== 'dsh-workbench.linux-artifacts.v1'
    || reviewedArtifacts.releaseVersion !== contract.release.version
    || ![reviewedArtifacts.runtimeKitPackageCanonicalSha256,
      reviewedArtifacts.profileWorkspaceRawSha256, reviewedArtifacts.profileLockRawSha256]
      .every(value => /^[a-f0-9]{64}$/.test(value))) {
    throw new Error('reviewed Linux artifact record is invalid');
  }
  const kitPin = contract.components.runtimeKit.source;
  const dshKit = readPinnedKitJson(kitRepo, 'compatibility/dsh.json', '/usr/bin/git', kitPin) as DshCompatibility;
  const nilsKit = readPinnedKitJson(kitRepo, 'compatibility/nils-cli.json', '/usr/bin/git', kitPin) as NilsCompatibility;
  sameJson(JSON.parse(readFileSync(join(root, 'runtime-kit/compatibility/dsh.json'), 'utf8')),
    dshKit, 'DSH compatibility');
  sameJson(JSON.parse(readFileSync(join(root, 'runtime-kit/compatibility/nils-cli.json'), 'utf8')),
    nilsKit, 'nils compatibility');
  if (dshKit.schema_version !== 'dsh-runtime-kit.dsh-compatibility.v1'
    || dshKit.repository !== contract.components.dsh.source.url
    || dshKit.validated_releases?.[contract.components.dsh.package.version]?.revision
      !== contract.components.dsh.source.commit
    || nilsKit.schema_version !== 'dsh-runtime-kit.nils-compatibility.v1'
    || nilsKit.status !== 'released' || nilsKit.release.platform !== 'x86_64-unknown-linux-gnu'
    || nilsKit.release.source_revision !== `v${nilsKit.validated_release}`
    || nilsKit.validated_release !== manifest.nilsRelease.version) {
    throw new Error('pinned compatibility records have the wrong identity');
  }
  const kitPackage = join(root, manifest.runtimeKit.packagePath);
  const kitManifest = JSON.parse(tarMember(kitPackage, 'package/package.json').toString('utf8')) as {
    name?: string; version?: string;
  };
  if (kitManifest.name !== contract.components.runtimeKit.package.name
    || kitManifest.version !== contract.components.runtimeKit.package.version) {
    throw new Error('runtime-kit package identity differs from contract');
  }
  const kitProof = JSON.parse(readFileSync(join(root, 'runtime-kit/source-build-proof.json'), 'utf8')) as {
    schemaVersion?: string; sourceCommit?: string; sourceTree?: string;
    packageCanonicalSha256?: string;
  };
  if (kitProof.schemaVersion !== 'dsh-workbench.runtime-kit-source-build.v1'
    || kitProof.sourceCommit !== contract.components.runtimeKit.source.commit
    || kitProof.sourceTree !== contract.components.runtimeKit.source.tree
    || kitProof.packageCanonicalSha256 !== reviewedArtifacts.runtimeKitPackageCanonicalSha256
    || kitProof.packageCanonicalSha256
      !== inspectPeerArtifact(readFileSync(kitPackage)).artifactSha256) {
    throw new Error('runtime-kit package differs from source-build proof');
  }
  sameJson(JSON.parse(tarMember(kitPackage, 'package/compatibility/dsh.json').toString('utf8')),
    dshKit, 'packed DSH compatibility');
  sameJson(JSON.parse(tarMember(kitPackage, 'package/compatibility/nils-cli.json').toString('utf8')),
    nilsKit, 'packed nils compatibility');

  const archiveDir = join(root, 'profile/artifacts');
  const dshName = artifactName(contract.components.dsh.package.name, contract.components.dsh.package.version);
  const tuiName = artifactName(contract.components.tui.package.name, contract.components.tui.package.version);
  const webName = `sympoies-dsh-workbench-web-${contract.release.version}.tgz`;
  const official = new Set([dshName, tuiName, webName, 'peer-closure.tgz']);
  const dsh = readFileSync(join(archiveDir, dshName));
  const tui = readFileSync(join(archiveDir, tuiName));
  const web = readFileSync(join(archiveDir, webName));
  if (integrity(dsh) !== contract.components.dsh.package.integrity
    || integrity(tui) !== contract.components.tui.package.integrity) {
    throw new Error('official component archive integrity differs from contract');
  }
  for (const [bytes, component] of [[dsh, contract.components.dsh], [tui, contract.components.tui]] as const) {
    const found = inspectPeerArtifact(bytes);
    const archivePath = `profile/artifacts/${artifactName(component.package.name, component.package.version)}`;
    if (found.name !== component.package.name || found.version !== component.package.version) {
      throw new Error('official component archive package identity differs from contract');
    }
    if (manifest.archives.find(archive => archive.path === archivePath)?.canonicalSha256
      !== found.artifactSha256) {
      throw new Error('official component canonical digest differs from release manifest');
    }
  }
  const webRecord = JSON.parse(readFileSync(join(root, 'compatibility/web-artifact.json'), 'utf8')) as {
    artifactSha256: string;
  };
  const webIdentity = inspectPeerArtifact(web);
  if (webIdentity.name !== '@sympoies/dsh-workbench-web'
    || webIdentity.version !== contract.release.version
    || webIdentity.artifactSha256 !== webRecord.artifactSha256
    || manifest.archives.find(archive => archive.path === `profile/artifacts/${webName}`)?.canonicalSha256
      !== webIdentity.artifactSha256) {
    throw new Error('Web archive differs from reviewed identity');
  }

  const peerFiles = readdirSync(archiveDir).filter(name => !official.has(name)).sort();
  const expected = Object.entries(dshKit.workspace_artifacts).map(([name, entry]) =>
    artifactName(name, entry.version)).sort();
  if (JSON.stringify(peerFiles) !== JSON.stringify(expected)) {
    throw new Error('peer archive set differs from pinned DSH closure');
  }
  const closure = inspectPeerBundle(readFileSync(join(archiveDir, 'peer-closure.tgz')));
  if (JSON.stringify([...closure.keys()].sort()) !== JSON.stringify(expected)) {
    throw new Error('bundled peer archive set differs from pinned closure');
  }
  const closureDigest = hash(peerFiles.map(name => hash(readFileSync(join(archiveDir, name)))).join('\n'));
  if (manifest.archives.find(archive => archive.path === 'profile/artifacts/peer-closure.tgz')?.canonicalSha256
    !== closureDigest) throw new Error('peer closure canonical digest differs from release manifest');
  const selected = new Map<string, string>();
  for (const [name, entry] of Object.entries(dshKit.workspace_artifacts)) {
    const file = artifactName(name, entry.version);
    const bytes = readFileSync(join(archiveDir, file));
    const found = inspectPeerArtifact(bytes);
    const canonical = dshKit.patched_workspace_artifacts[name] ?? entry.artifact_sha256;
    const registry = dshKit.registry_workspace_artifacts?.[name];
    if (found.name !== name || found.version !== entry.version
      || found.artifactSha256 !== canonical
      || (registry && integrity(bytes) !== registry.integrity)
      || !closure.get(file)?.equals(bytes)) {
      throw new Error(`peer archive differs from pinned closure: ${name}`);
    }
    if (!registry?.platform || registry.platform === 'linux-x64') {
      selected.set(name, `file:artifacts/${file}`);
    }
  }
  selected.set(contract.components.dsh.package.name, `file:artifacts/${dshName}`);
  selected.set(contract.components.tui.package.name, `file:artifacts/${tuiName}`);
  selected.set('@sympoies/dsh-workbench-web', `file:artifacts/${webName}`);
  const actualProfilePaths = manifest.files.filter(file => file.role === 'profile')
    .map(file => file.path).filter(path => path !== 'profile/artifacts/peer-closure.tgz').sort();
  if (JSON.stringify(actualProfilePaths) !== JSON.stringify(expectedProfilePaths(contract, dshKit))) {
    throw new Error('frozen profile contains missing or unreviewed files');
  }
  validateFrozenProfileManifest(JSON.parse(readFileSync(join(root, 'profile/package.json'), 'utf8')),
    selected, contract);
  if (hash(readFileSync(join(root, 'profile/pnpm-workspace.yaml')))
    !== reviewedArtifacts.profileWorkspaceRawSha256
    || hash(readFileSync(join(root, 'profile/pnpm-lock.yaml')))
      !== reviewedArtifacts.profileLockRawSha256) {
    throw new Error('frozen profile workspace or lock differs from reviewed artifact record');
  }
  if (!readFileSync(join(root, 'profile/pnpm-lock.yaml'))
    .equals(sourceBlob('compatibility/linux-profile-lock.yaml'))) {
    throw new Error('frozen profile lock differs from reviewed builder source');
  }
  const exactFiles: Array<[string, string | Buffer]> = [
    ['profile/LICENSE', sourceBlob('LICENSE')],
    ['profile/THIRD_PARTY_NOTICES.md', sourceBlob('THIRD_PARTY_NOTICES.md')],
    ['profile/patches/tui-rename.patch', sourceBlob(contract.components.tui.compatibilityPatch!.path)],
    ['profile/cordis.yml', '[]\n'],
    ['profile/cordis.patch.yml', "- insert:\n    - id: dsh-workbench-web\n      name: '@sympoies/dsh-workbench-web'\n"],
    ['profile/workbench-tui/LICENSE', sourceBlob('LICENSE')],
    ['profile/workbench-tui/src/launch-workbench.ts', sourceBlob('src/launch-workbench.ts')],
    ['profile/workbench-tui/scripts/launch-workbench-tui.ts',
      sourceBlob('scripts/launch-workbench-tui.ts')],
  ];
  for (const [path, expectedBytes] of exactFiles) {
    if (!readFileSync(join(root, path)).equals(Buffer.isBuffer(expectedBytes)
      ? expectedBytes : Buffer.from(expectedBytes))) {
      throw new Error(`frozen profile file differs from reviewed source: ${path}`);
    }
  }
  const tuiReceipt = JSON.parse(readFileSync(join(root, 'profile/workbench-tui/receipt.json'), 'utf8')) as {
    schemaVersion?: string; releaseVersion?: string; entry?: string;
    files?: Array<{ path: string; sha256: string }>;
  };
  if (tuiReceipt.schemaVersion !== 'dsh-workbench.installed-tui-entry.v1'
    || tuiReceipt.releaseVersion !== contract.release.version
    || tuiReceipt.entry !== 'scripts/launch-workbench-tui.ts'
    || JSON.stringify(tuiReceipt.files) !== JSON.stringify([
      { path: 'src/launch-workbench.ts', sha256: hash(readFileSync(join(root, 'profile/workbench-tui/src/launch-workbench.ts'))) },
      { path: 'scripts/launch-workbench-tui.ts', sha256: hash(readFileSync(join(root, 'profile/workbench-tui/scripts/launch-workbench-tui.ts'))) },
      { path: 'LICENSE', sha256: hash(readFileSync(join(root, 'profile/workbench-tui/LICENSE'))) },
    ])) throw new Error('installed TUI entry receipt differs from reviewed source');
  const nilsArchive = join(root, manifest.nilsRelease.archivePath);
  if (hash(readFileSync(nilsArchive)) !== nilsKit.release.archive.sha256) {
    throw new Error('nils archive differs from pinned release');
  }
  const prefix = `nils-cli-v${nilsKit.validated_release}-x86_64-unknown-linux-gnu`;
  for (const [name, entry] of Object.entries(nilsKit.release.artifacts)) {
    const bytes = tarMember(nilsArchive, `${prefix}/bin/${name}`);
    if (hash(bytes) !== entry.sha256
      || !bytes.equals(readFileSync(join(root, 'nils/bin', name)))) {
      throw new Error(`nils executable differs from pinned release: ${name}`);
    }
  }
  return { releaseVersion: contract.release.version, peerArchives: peerFiles.length,
    profileLockSha256: hash(readFileSync(join(root, 'profile/pnpm-lock.yaml'))) };
}
