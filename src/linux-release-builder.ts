import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkbenchContract } from './contract-types.ts';
import { inspectPeerArtifact } from './package-artifact.ts';
import { readPinnedKitJson } from './pinned-kit.ts';
import { expectedProfilePaths, verifyLinuxReleaseContents } from './linux-release-content.ts';
import type { LinuxReleaseFile, LinuxReleaseManifest, LinuxReleaseRole } from './linux-release-manifest.ts';
import { workbenchIdentity } from '../web/src/identity.ts';

const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const contract = JSON.parse(readFileSync(join(sourceRoot, 'compatibility/workbench.json'), 'utf8')) as WorkbenchContract;
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const kitRecordPath = 'compatibility/nils-cli.json';
const roles: Record<string, LinuxReleaseRole> = {
  compatibility: 'contract', installer: 'installer', profile: 'profile',
  'runtime-kit': 'runtimeKit', nils: 'nilsTool', notices: 'notices',
  'license-inventory': 'licenseInventory',
};

export type LinuxReleaseBuildInput = {
  frozenProfile: string;
  runtimeKitRepo: string;
  runtimeKitPackage: string;
  nilsArchive: string;
  profileLicenseInventory: string;
  cliLicenseInventory: string;
  outputRoot: string;
  outputArchive: string;
};

function command(executable: string, args: string[], cwd?: string,
  maxBuffer = 8 * 1024 * 1024, timeout = 60_000): Buffer {
  const result = spawnSync(executable, args, { cwd, timeout, maxBuffer });
  if (result.status !== 0 || result.error) throw new Error(`${executable} failed during Linux release build`);
  return result.stdout;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith('GIT_')) delete environment[key];
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = '/dev/null';
  environment.GIT_OPTIONAL_LOCKS = '0';
  return environment;
}

function verifyKitSourceBuild(kitRepo: string, packageArchive: string): string {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-workbench-kit-source-'));
  chmodSync(temp, 0o700);
  try {
    const gitTar = join(temp, 'source.tar');
    const git = spawnSync('/usr/bin/git', ['archive', '--format=tar', '--output', gitTar,
      contract.components.runtimeKit.source.commit], {
      cwd: kitRepo, env: gitEnvironment(), timeout: 60_000,
    });
    if (git.status !== 0 || git.error) throw new Error('pinned runtime-kit source cannot be archived');
    const source = join(temp, 'source');
    const packageRoot = join(temp, 'package');
    mkdirSync(source, { mode: 0o700 });
    mkdirSync(packageRoot, { mode: 0o700 });
    command('/usr/bin/tar', ['-xf', gitTar, '-C', source]);
    command('npm', ['ci', '--ignore-scripts', '--omit=peer', '--no-audit', '--no-fund'],
      source, 16 * 1024 * 1024, 300_000);
    command('npm', ['run', 'build:emit'], source, 16 * 1024 * 1024, 300_000);
    command('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', packageRoot],
      source, 16 * 1024 * 1024, 120_000);
    const packages = readdirSync(packageRoot).filter(name => name.endsWith('.tgz'));
    if (packages.length !== 1) throw new Error('pinned runtime-kit build did not produce one package');
    const rebuilt = inspectPeerArtifact(readFileSync(join(packageRoot, packages[0])));
    const candidate = inspectPeerArtifact(readFileSync(packageArchive));
    if (rebuilt.name !== contract.components.runtimeKit.package.name
      || rebuilt.version !== contract.components.runtimeKit.package.version
      || candidate.name !== rebuilt.name || candidate.version !== rebuilt.version
      || candidate.artifactSha256 !== rebuilt.artifactSha256) {
      throw new Error('runtime-kit package differs from build of pinned source tree');
    }
    return rebuilt.artifactSha256;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function safeInput(path: string, kind: 'file' | 'directory'): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('release input must be an absolute canonical path');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || stat.uid !== process.getuid?.() || stat.isSymbolicLink()
    || (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) {
    throw new Error('release input has an unsafe type or owner');
  }
}

function sourceRevision(): { commit: string; tree: string } {
  const environment = gitEnvironment();
  const read = (args: string[]): string => {
    const result = spawnSync('/usr/bin/git', args, {
      cwd: sourceRoot, env: environment, encoding: 'utf8', timeout: 30_000,
    });
    if (result.status !== 0 || result.error) throw new Error('release builder Git identity is unavailable');
    return result.stdout.trim();
  };
  if (read(['rev-parse', '--show-toplevel']) !== sourceRoot) {
    throw new Error('release builder source is not the expected checkout');
  }
  const status = read(['status', '--porcelain', '--untracked-files=all']);
  if (status.trim()) throw new Error('release builder source checkout must be clean');
  const [commit, tree] = read(['rev-parse', 'HEAD', 'HEAD^{tree}']).split('\n');
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)) {
    throw new Error('release builder source revision is unavailable');
  }
  return { commit, tree };
}

function sourceBlob(commit: string, path: string): Buffer {
  const result = spawnSync('/usr/bin/git', ['show', `${commit}:${path}`], {
    cwd: sourceRoot, env: gitEnvironment(), timeout: 30_000, maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error(`reviewed source file is unavailable: ${path}`);
  return result.stdout;
}

function write(root: string, path: string, bytes: Buffer | string, mode: 0o644 | 0o755 = 0o644): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
  writeFileSync(target, bytes, { flag: 'wx', mode });
  chmodSync(target, mode);
}

function copy(root: string, from: string, to: string, mode?: 0o644 | 0o755): void {
  safeInput(from, 'file');
  const stat = lstatSync(from);
  const inputMode = stat.mode & 0o7777;
  if (mode === undefined && inputMode !== 0o644 && inputMode !== 0o755) {
    throw new Error(`release file has unsafe mode: ${to}`);
  }
  write(root, to, readFileSync(from), mode ?? inputMode as 0o644 | 0o755);
}

function copyProfile(root: string, profile: string, allowed: readonly string[]): void {
  const seen = new Set<string>();
  const allowedSet = new Set(allowed);
  const visit = (directory: string, target: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (directory === profile && entry.name === 'node_modules') continue;
      const input = join(directory, entry.name);
      const path = join(target, entry.name).split(sep).join('/');
      const stat = lstatSync(input);
      if (stat.uid !== process.getuid?.() || stat.isSymbolicLink()) {
        throw new Error('frozen profile contains an unsafe entry');
      }
      if (stat.isDirectory()) {
        if ((stat.mode & 0o022) !== 0) throw new Error('frozen profile has writable directory');
        visit(input, path);
      } else if (stat.isFile()) {
        if (!allowedSet.has(path)) throw new Error(`frozen profile has an unreviewed file: ${path}`);
        seen.add(path);
        copy(root, input, path);
      }
      else throw new Error('frozen profile contains a non-regular entry');
    }
  };
  visit(profile, 'profile');
  if (JSON.stringify([...seen].sort()) !== JSON.stringify([...allowed].sort())) {
    throw new Error('frozen profile is incomplete');
  }
}

function index(root: string): LinuxReleaseFile[] {
  const files: LinuxReleaseFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const name = relative(root, path).split(sep).join('/');
        const role = roles[name.split('/')[0]];
        const stat = lstatSync(path);
        const mode = `0${(stat.mode & 0o7777).toString(8)}`;
        if (!role || (mode !== '0644' && mode !== '0755')) throw new Error('release index has unknown role or mode');
        files.push({ path: name, role, size: stat.size, mode,
          rawSha256: sha256(readFileSync(path)) });
      } else throw new Error('release index has non-regular entry');
    }
  };
  visit(root);
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function licenseInventory(path: string): void {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    schemaVersion?: string; packageCount?: number;
    packages?: Array<{ name: string; version: string; license: string }>;
  };
  if (parsed.schemaVersion !== 'dsh-workbench.dependency-license-inventory.v1'
    || !Array.isArray(parsed.packages) || parsed.packages.length !== parsed.packageCount
    || parsed.packages.length === 0 || parsed.packages.some(item =>
      !item.name || !item.version || !item.license)) {
    throw new Error('production license inventory is incomplete');
  }
}

/** Assemble a release candidate only from explicit, authenticated inputs. */
export function buildLinuxRelease(input: LinuxReleaseBuildInput): {
  releaseVersion: string; archiveSha256: string; manifestSha256: string; files: number; peerArchives: number;
} {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux x64 builder requires Linux x64');
  if (JSON.stringify(contract.runtime.platforms) !== '["linux-x64"]' || contract.status !== 'accepted') {
    throw new Error('release contract is not accepted for Linux x64');
  }
  for (const path of [input.frozenProfile, input.runtimeKitRepo]) safeInput(path, 'directory');
  for (const path of [input.runtimeKitPackage, input.nilsArchive,
    input.profileLicenseInventory, input.cliLicenseInventory]) safeInput(path, 'file');
  for (const path of [input.outputRoot, input.outputArchive]) {
    if (!isAbsolute(path) || resolve(path) !== path || lstatSync(path, { throwIfNoEntry: false })) {
      throw new Error('release output must be a new absolute path');
    }
  }
  if (input.outputArchive.startsWith(`${input.outputRoot}/`)
    || input.outputRoot.startsWith(`${input.outputArchive}/`)) {
    throw new Error('release outputs cannot contain one another');
  }
  const builderSource = sourceRevision();
  licenseInventory(input.profileLicenseInventory);
  licenseInventory(input.cliLicenseInventory);
  const nils = readPinnedKitJson(input.runtimeKitRepo, kitRecordPath) as {
    validated_release: string;
    release: { archive: { name: string; sha256: string }; artifacts: Record<string, { sha256: string }> };
  };
  const dshKit = readPinnedKitJson(input.runtimeKitRepo, 'compatibility/dsh.json') as Parameters<typeof expectedProfilePaths>[1];
  if (sha256(readFileSync(input.nilsArchive)) !== nils.release.archive.sha256) {
    throw new Error('nils archive differs from pinned runtime-kit source');
  }
  const kitCanonicalSha256 = verifyKitSourceBuild(input.runtimeKitRepo, input.runtimeKitPackage);
  const nilsPrefix = `nils-cli-v${nils.validated_release}-x86_64-unknown-linux-gnu`;
  let madeRoot = false;
  try {
    mkdirSync(input.outputRoot, { mode: 0o700 });
    madeRoot = true;
    chmodSync(input.outputRoot, 0o700);
    for (const path of ['compatibility/workbench.json', 'compatibility/web-artifact.json',
      'compatibility/linux-artifacts.json',
      'compatibility/patches/tui-rename.patch']) {
      write(input.outputRoot, path, sourceBlob(builderSource.commit, path));
    }
    for (const path of ['scripts/contract.mjs', 'src/contract.ts', 'src/contract-types.ts',
      'src/linux-release-manifest.ts', 'src/linux-release-content.ts', 'src/pinned-kit.ts',
      'src/package-artifact.ts']) write(input.outputRoot, `installer/${path}`,
        sourceBlob(builderSource.commit, path));
    write(input.outputRoot, 'installer/package.json', '{"type":"module"}\n');
    copyProfile(input.outputRoot, input.frozenProfile, expectedProfilePaths(contract, dshKit));
    const artifactDir = join(input.outputRoot, 'profile/artifacts');
    const dshPath = `profile/artifacts/${contract.components.dsh.package.name.slice(1).replace('/', '-')}-${contract.components.dsh.package.version}.tgz`;
    const tuiPath = `profile/artifacts/${contract.components.tui.package.name.slice(1).replace('/', '-')}-${contract.components.tui.package.version}.tgz`;
    const webPath = `profile/artifacts/sympoies-dsh-workbench-web-${contract.release.version}.tgz`;
    const official = new Set([dshPath, tuiPath, webPath]);
    const peers = readdirSync(artifactDir).filter(name => name.endsWith('.tgz')
      && !official.has(`profile/artifacts/${name}`)).sort();
    const expectedPeers = Object.entries(dshKit.workspace_artifacts).map(([name, entry]) =>
      `${name.slice(1).replace('/', '-')}-${entry.version}.tgz`).sort();
    if (JSON.stringify(peers) !== JSON.stringify(expectedPeers)) {
      throw new Error('frozen profile peer set differs from pinned source');
    }
    const peerBundle = 'profile/artifacts/peer-closure.tgz';
    command('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '-czf', join(input.outputRoot, peerBundle), '--', ...peers], artifactDir);
    chmodSync(join(input.outputRoot, peerBundle), 0o644);
    copy(input.outputRoot, input.runtimeKitPackage, 'runtime-kit/package.tgz');
    write(input.outputRoot, 'runtime-kit/source-build-proof.json', `${JSON.stringify({
      schemaVersion: 'dsh-workbench.runtime-kit-source-build.v1',
      sourceCommit: contract.components.runtimeKit.source.commit,
      sourceTree: contract.components.runtimeKit.source.tree,
      packageCanonicalSha256: kitCanonicalSha256,
    }, null, 2)}\n`);
    for (const name of ['dsh.json', 'nils-cli.json']) {
      const pinned = readPinnedKitJson(input.runtimeKitRepo, `compatibility/${name}` as typeof kitRecordPath);
      write(input.outputRoot, `runtime-kit/compatibility/${name}`,
        `${JSON.stringify(pinned, null, 2)}\n`);
    }
    copy(input.outputRoot, input.nilsArchive, `nils/${nils.release.archive.name}`);
    for (const [name, entry] of Object.entries(nils.release.artifacts)) {
      const bytes = command('tar', ['-xOzf', input.nilsArchive, `${nilsPrefix}/bin/${name}`],
        undefined, 128 * 1024 * 1024);
      if (sha256(bytes) !== entry.sha256) throw new Error(`nils tool differs from pinned release: ${name}`);
      write(input.outputRoot, `nils/bin/${name}`, bytes, 0o755);
    }
    write(input.outputRoot, 'notices/LICENSE', sourceBlob(builderSource.commit, 'LICENSE'));
    write(input.outputRoot, 'notices/THIRD_PARTY_NOTICES.md',
      sourceBlob(builderSource.commit, 'THIRD_PARTY_NOTICES.md'));
    write(input.outputRoot, 'notices/nils-cli-THIRD_PARTY_LICENSES.md',
      command('tar', ['-xOzf', input.nilsArchive, `${nilsPrefix}/THIRD_PARTY_LICENSES.md`]));
    copy(input.outputRoot, input.profileLicenseInventory, 'license-inventory/profile-production.json');
    copy(input.outputRoot, input.cliLicenseInventory, 'license-inventory/cli-host-production.json');

    const files = index(input.outputRoot);
    const byPath = new Map(files.map(file => [file.path, file]));
    const archives = [dshPath, tuiPath, webPath, peerBundle].map(path => ({
      path, rawSha256: byPath.get(path)!.rawSha256,
      canonicalSha256: path === peerBundle
        ? sha256(peers.map(name => sha256(readFileSync(join(artifactDir, name)))).join('\n'))
        : inspectPeerArtifact(readFileSync(join(input.outputRoot, path))).artifactSha256,
    }));
    const manifest: LinuxReleaseManifest = {
      schemaVersion: 'dsh-workbench.linux-release.v1', releaseVersion: contract.release.version,
      platform: 'linux-x64', contractPath: 'compatibility/workbench.json',
      contractRawSha256: byPath.get('compatibility/workbench.json')!.rawSha256,
      graphSha256: workbenchIdentity.graphDigest.slice(7),
      builderSource: { repository: 'https://github.com/sympoies/dsh-workbench', ...builderSource },
      files, archives,
      runtimeKit: { sourceCommit: contract.components.runtimeKit.source.commit,
        sourceTree: contract.components.runtimeKit.source.tree,
        packagePath: 'runtime-kit/package.tgz',
        packageRawSha256: byPath.get('runtime-kit/package.tgz')!.rawSha256 },
      nilsRelease: { version: nils.validated_release, archivePath: `nils/${nils.release.archive.name}`,
        archiveRawSha256: nils.release.archive.sha256,
        toolPaths: Object.keys(nils.release.artifacts).map(name => `nils/bin/${name}`).sort() },
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    write(input.outputRoot, 'release-manifest.json', manifestBytes);
    const manifestSha256 = sha256(manifestBytes);
    const content = verifyLinuxReleaseContents(input.outputRoot, manifestSha256, input.runtimeKitRepo);
    command('tar', ['--format=ustar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '-czf', input.outputArchive, '-C', input.outputRoot, '.']);
    chmodSync(input.outputArchive, 0o644);
    return { releaseVersion: contract.release.version,
      archiveSha256: sha256(readFileSync(input.outputArchive)), manifestSha256,
      files: files.length, peerArchives: content.peerArchives };
  } catch (error) {
    if (madeRoot) rmSync(input.outputRoot, { recursive: true, force: true });
    if (lstatSync(input.outputArchive, { throwIfNoEntry: false })) rmSync(input.outputArchive);
    throw error;
  }
}
