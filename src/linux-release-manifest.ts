import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkbenchContract } from './contract-types.ts';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const digestPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const roleRoots = {
  contract: 'compatibility/',
  installer: 'installer/',
  profile: 'profile/',
  runtimeKit: 'runtime-kit/',
  nilsTool: 'nils/',
  notices: 'notices/',
  licenseInventory: 'license-inventory/',
} as const;

export type LinuxReleaseRole = keyof typeof roleRoots;
export type LinuxReleaseFile = {
  path: string;
  role: LinuxReleaseRole;
  size: number;
  mode: '0644' | '0755';
  rawSha256: string;
};
export type LinuxReleaseManifest = {
  schemaVersion: 'dsh-workbench.linux-release.v1';
  releaseVersion: string;
  platform: 'linux-x64';
  contractPath: 'compatibility/workbench.json';
  contractRawSha256: string;
  graphSha256: string;
  builderSource: { repository: string; commit: string; tree: string };
  files: LinuxReleaseFile[];
  archives: Array<{ path: string; rawSha256: string; canonicalSha256: string }>;
  runtimeKit: { sourceCommit: string; sourceTree: string; packagePath: string; packageRawSha256: string };
  nilsRelease: { version: string; archivePath: string; archiveRawSha256: string; toolPaths: string[] };
};

function fail(message: string): never {
  throw new Error(`LINUX_RELEASE_INVALID: ${message}`);
}

function record(value: unknown, keys: string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    fail(`${name} has unexpected fields`);
  }
  return value as Record<string, unknown>;
}

function digest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) fail(`${name} is not SHA-256`);
  return value;
}

function payloadPath(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/')
    || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    fail(`${name} is not a canonical relative path`);
  }
  return value;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function graphSha256(contract: WorkbenchContract): string {
  const graph = {
    schemaVersion: 2,
    release: contract.release,
    runtime: contract.runtime,
    components: Object.fromEntries(Object.entries(contract.components).map(([name, component]) => [name, {
      source: component.source,
      package: component.package,
      toolchain: component.toolchain,
      ...('peerOverrides' in component ? { peerOverrides: component.peerOverrides } : {}),
      ...('compatibilityPatch' in component ? { compatibilityPatch: component.compatibilityPatch } : {}),
    }])),
  };
  return sha256(JSON.stringify(graph));
}

function indexedFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.uid !== process.getuid?.()) fail('release entry has an unexpected owner');
      if (stat.isSymbolicLink()) fail('release contains a symbolic link');
      if (stat.isDirectory()) {
        if ((stat.mode & 0o022) !== 0) fail('release contains a writable directory');
        visit(path);
      }
      else if (stat.isFile()) {
        if (stat.nlink !== 1) fail('release contains a hard link');
        files.push(relative(root, path).split(sep).join('/'));
      }
      else fail('release contains a non-regular entry');
    }
  };
  visit(root);
  return files.sort();
}

/** Verify the release envelope before a separate artifact and owner install check. */
export function verifyLinuxReleaseEnvelope(root: string, expectedManifestSha256: string): LinuxReleaseManifest {
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!isAbsolute(root) || resolve(root) !== root || !rootStat?.isDirectory()) {
    fail('release root must be an absolute directory');
  }
  if (realpathSync(root) !== root || rootStat.uid !== process.getuid?.()
    || (rootStat.mode & 0o7777) !== 0o700) {
    fail('release root must be private and owned by the verifier');
  }
  digest(expectedManifestSha256, 'expected manifest digest');
  const manifestPath = join(root, 'release-manifest.json');
  const manifestStat = lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!manifestStat?.isFile() || manifestStat.uid !== process.getuid?.()
    || manifestStat.nlink !== 1 || (manifestStat.mode & 0o7777) !== 0o644) {
    fail('manifest is unavailable or has unsafe metadata');
  }
  const manifestBytes = readFileSync(manifestPath);
  if (sha256(manifestBytes) !== expectedManifestSha256) fail('manifest digest mismatch');
  let parsed: unknown;
  try { parsed = JSON.parse(manifestBytes.toString('utf8')); }
  catch { fail('manifest JSON is invalid'); }
  const manifest = record(parsed, ['schemaVersion', 'releaseVersion', 'platform', 'contractPath',
    'contractRawSha256', 'graphSha256', 'builderSource', 'files', 'archives', 'runtimeKit', 'nilsRelease'],
  'manifest') as LinuxReleaseManifest;
  if (manifest.schemaVersion !== 'dsh-workbench.linux-release.v1'
    || manifest.platform !== 'linux-x64' || process.platform !== 'linux' || process.arch !== 'x64') {
    fail('unsupported release schema or platform');
  }
  if (manifest.contractPath !== 'compatibility/workbench.json') fail('contract path changed');
  digest(manifest.contractRawSha256, 'contract digest');
  digest(manifest.graphSha256, 'graph digest');
  const source = record(manifest.builderSource, ['repository', 'commit', 'tree'], 'builder source');
  if (source.repository !== 'https://github.com/sympoies/dsh-workbench'
    || typeof source.commit !== 'string' || !commitPattern.test(source.commit)
    || typeof source.tree !== 'string' || !commitPattern.test(source.tree)) {
    fail('builder source identity is invalid');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('file index is empty');
  const byPath = new Map<string, LinuxReleaseFile>();
  let previous = '';
  for (const unknownFile of manifest.files) {
    const file = record(unknownFile, ['path', 'role', 'size', 'mode', 'rawSha256'], 'file') as LinuxReleaseFile;
    const path = payloadPath(file.path, 'file path');
    if (path <= previous || path === 'release-manifest.json') fail('file index is not sorted and unique');
    previous = path;
    if (!(file.role in roleRoots) || !path.startsWith(roleRoots[file.role])) fail('file role/path mismatch');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !['0644', '0755'].includes(file.mode)) {
      fail('file size or mode is invalid');
    }
    digest(file.rawSha256, 'file digest');
    byPath.set(path, file);
  }
  const actualPaths = indexedFiles(root);
  const expectedPaths = [...byPath.keys(), 'release-manifest.json'].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) fail('release file index is not closed');
  for (const [path, file] of byPath) {
    const stat = lstatSync(join(root, path));
    if (!stat.isFile() || stat.size !== file.size
      || (stat.mode & 0o7777) !== Number.parseInt(file.mode, 8)
      || sha256(readFileSync(join(root, path))) !== file.rawSha256) {
      fail(`indexed file differs: ${path}`);
    }
  }
  if (byPath.get(manifest.contractPath)?.rawSha256 !== manifest.contractRawSha256) {
    fail('contract digest differs from index');
  }
  const contractFile = join(root, manifest.contractPath);
  const check = spawnSync(process.execPath,
    [join(sourceRoot, 'scripts/contract.mjs'), 'require-accepted', '--contract', contractFile],
    { encoding: 'utf8', timeout: 15_000 });
  if (check.status !== 0) fail('contract is not accepted');
  const contract = JSON.parse(readFileSync(contractFile, 'utf8')) as WorkbenchContract;
  if (manifest.releaseVersion !== contract.release.version
    || JSON.stringify(contract.runtime.platforms) !== '["linux-x64"]'
    || manifest.graphSha256 !== graphSha256(contract)) {
    fail('release graph differs from accepted contract');
  }
  if (!Array.isArray(manifest.archives) || manifest.archives.length === 0) fail('archive index is empty');
  const archivePaths = new Set<string>();
  for (const archive of manifest.archives) {
    record(archive, ['path', 'rawSha256', 'canonicalSha256'], 'archive');
    const path = payloadPath(archive.path, 'archive path');
    if (archivePaths.has(path) || byPath.get(path)?.role !== 'profile'
      || byPath.get(path)?.rawSha256 !== digest(archive.rawSha256, 'archive digest')) {
      fail('archive identity differs from file index');
    }
    digest(archive.canonicalSha256, 'canonical archive digest');
    archivePaths.add(path);
  }
  const componentArchive = (name: string, version: string): string =>
    `profile/artifacts/${name.slice(1).replace('/', '-')}-${version}.tgz`;
  const requiredArchivePaths = [
    componentArchive(contract.components.dsh.package.name, contract.components.dsh.package.version),
    componentArchive(contract.components.tui.package.name, contract.components.tui.package.version),
    `profile/artifacts/sympoies-dsh-workbench-web-${contract.release.version}.tgz`,
    'profile/artifacts/peer-closure.tgz',
  ];
  if (JSON.stringify([...archivePaths].sort()) !== JSON.stringify(requiredArchivePaths.sort())) {
    fail('required release archive set is incomplete or changed');
  }
  for (const path of ['profile/package.json', 'profile/pnpm-workspace.yaml', 'profile/pnpm-lock.yaml']) {
    if (byPath.get(path)?.role !== 'profile') fail(`frozen profile input is missing: ${path}`);
  }
  const webRecordPath = 'compatibility/web-artifact.json';
  if (byPath.get(webRecordPath)?.role !== 'contract') fail('reviewed Web artifact record is missing');
  let webRecord: Record<string, unknown>;
  try { webRecord = JSON.parse(readFileSync(join(root, webRecordPath), 'utf8')) as Record<string, unknown>; }
  catch { fail('reviewed Web artifact record is invalid'); }
  const webArchivePath = `profile/artifacts/sympoies-dsh-workbench-web-${contract.release.version}.tgz`;
  if (webRecord.schemaVersion !== 'dsh-workbench.web-artifact.v1'
    || webRecord.releaseVersion !== contract.release.version
    || webRecord.name !== '@sympoies/dsh-workbench-web'
    || manifest.archives.find(archive => archive.path === webArchivePath)?.canonicalSha256
      !== digest(webRecord.artifactSha256, 'reviewed Web canonical digest')) {
    fail('Web archive identity differs from reviewed artifact record');
  }
  const kit = record(manifest.runtimeKit,
    ['sourceCommit', 'sourceTree', 'packagePath', 'packageRawSha256'], 'runtime-kit');
  if (kit.sourceCommit !== contract.components.runtimeKit.source.commit
    || kit.sourceTree !== contract.components.runtimeKit.source.tree
    || byPath.get(payloadPath(kit.packagePath, 'runtime-kit package path'))?.role !== 'runtimeKit'
    || byPath.get(kit.packagePath as string)?.rawSha256
      !== digest(kit.packageRawSha256, 'runtime-kit package digest')) {
    fail('runtime-kit identity differs from contract or index');
  }
  const nils = record(manifest.nilsRelease,
    ['version', 'archivePath', 'archiveRawSha256', 'toolPaths'], 'nils release');
  if (typeof nils.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(nils.version)
    || byPath.get(payloadPath(nils.archivePath, 'nils archive path'))?.role !== 'nilsTool'
    || byPath.get(nils.archivePath as string)?.rawSha256
      !== digest(nils.archiveRawSha256, 'nils archive digest')
    || !Array.isArray(nils.toolPaths) || nils.toolPaths.length !== 7
    || new Set(nils.toolPaths).size !== 7
    || nils.toolPaths.some(path => {
      const file = byPath.get(payloadPath(path, 'nils tool path'));
      return file?.role !== 'nilsTool' || file.mode !== '0755';
    })) {
    fail('nils release identity or tool set is invalid');
  }
  const nilsCompatibilityPath = 'runtime-kit/compatibility/nils-cli.json';
  if (byPath.get(nilsCompatibilityPath)?.role !== 'runtimeKit') {
    fail('runtime-kit nils compatibility record is missing');
  }
  let kitNils: Record<string, unknown>;
  try { kitNils = JSON.parse(readFileSync(join(root, nilsCompatibilityPath), 'utf8')) as Record<string, unknown>; }
  catch { fail('runtime-kit nils compatibility record is invalid'); }
  const kitRelease = kitNils.release as Record<string, unknown> | undefined;
  const kitArchive = kitRelease?.archive as Record<string, unknown> | undefined;
  const kitArchiveName = kitArchive?.name;
  const nilsArchivePath = nils.archivePath;
  const kitTools = kitRelease?.artifacts as Record<string, { sha256?: string }> | undefined;
  if (kitNils.schema_version !== 'dsh-runtime-kit.nils-compatibility.v1'
    || kitNils.status !== 'released' || kitRelease?.platform !== 'x86_64-unknown-linux-gnu'
    || kitRelease.source_revision !== `v${nils.version}`
    || kitArchive?.sha256 !== nils.archiveRawSha256
    || typeof kitArchiveName !== 'string' || typeof nilsArchivePath !== 'string'
    || !nilsArchivePath.endsWith(`/${kitArchiveName}`)
    || kitTools === undefined || Object.keys(kitTools).length !== 7) {
    fail('nils release differs from pinned runtime-kit compatibility');
  }
  const expectedToolPaths = Object.keys(kitTools).map(name => `nils/bin/${name}`).sort();
  if (JSON.stringify([...nils.toolPaths].sort()) !== JSON.stringify(expectedToolPaths)) {
    fail('nils tools differ from pinned runtime-kit compatibility');
  }
  for (const [name, tool] of Object.entries(kitTools)) {
    if (byPath.get(`nils/bin/${name}`)?.rawSha256 !== digest(tool.sha256, 'nils tool digest')) {
      fail('nils tool digest differs from pinned runtime-kit compatibility');
    }
  }
  return manifest;
}
