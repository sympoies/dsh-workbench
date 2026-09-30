import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkbenchContract } from './contract-types.ts';
import { readPinnedKitJson } from './pinned-kit.ts';
import { inspectPeerArtifact, normalizePeerArtifact } from './package-artifact.ts';
import { materializeTuiEntry } from './launch-workbench.ts';
import { WORKBENCH_PROFILE_PATCH } from './profile-patch.ts';

export { WORKBENCH_PROFILE_PATCH };

type Artifact = { name: string; version: string; path: string; tarball_sha256: string; artifact_sha256: string };
type PeerReceipt = {
  schema_version: string;
  ok: boolean;
  data: {
    channel: string;
    revision: string;
    patch_state: string;
    patch_id: string | null;
    upstream_checkout_clean: boolean;
    packages: Artifact[];
  };
};
type KitManifest = {
  schema_version: string;
  repository: string;
  validated_releases: Record<string, { revision: string }>;
  public_packages: Record<string, unknown>;
  workspace_artifacts: Record<string, { version: string; artifact_sha256: string }>;
  patched_workspace_artifacts: Record<string, string>;
  registry_workspace_artifacts?: Record<string, { integrity: string; platform?: string }>;
};

const root = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(join(root, 'compatibility/workbench.json'), 'utf8')) as WorkbenchContract;
const webArtifact = JSON.parse(readFileSync(join(root, 'compatibility/web-artifact.json'), 'utf8')) as {
  schemaVersion: string; releaseVersion: string; name: string; artifactSha256: string;
};
const packageName = /^@deepseek-ai\/[a-z0-9-]+$/;
const sha256 = /^[a-f0-9]{64}$/;

function artifactFile(name: string, version: string): string {
  if (!packageName.test(name) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/.test(version)) {
    throw new Error('invalid patched DSH artifact identity');
  }
  return `${name.slice(1).replace('/', '-')}-${version}.tgz`;
}

/**
 * Stage the exact patched DSH peer closure and TUI before runtime-kit setup.
 * The CLI reads the pinned kit source and accepts its patched peer-pack
 * receipt. This function authenticates those archives, the pinned TUI tarball, and the
 * pinned provider tarball before writing only relative artifact references.
 */
export function stageCombinedProfile(input: {
  profile: string;
  receipt: PeerReceipt;
  kitManifest: KitManifest;
  tuiArchive: string;
  webArchive: string;
  cliArchive: string;
  providerArchive: string;
}, expectedTuiIntegrity = contract.components.tui.package.integrity,
expectedWebArtifactSha256 = webArtifact.artifactSha256,
expectedCliIntegrity = contract.components.dsh.package.integrity,
expectedProviderIntegrity = contract.components.codexSubscription.package.integrity): void {
  const { profile, receipt, kitManifest, tuiArchive, webArchive, cliArchive, providerArchive } = input;
  if (!isAbsolute(profile)) throw new Error('profile target must be a new absolute path');
  if (!isAbsolute(tuiArchive) || !lstatSync(tuiArchive).isFile()) {
    throw new Error('TUI archive must be an absolute regular file');
  }
  const tuiBytes = readFileSync(tuiArchive);
  const tuiIntegrity = `sha512-${createHash('sha512').update(tuiBytes).digest('base64')}`;
  if (tuiIntegrity !== expectedTuiIntegrity) throw new Error('TUI archive integrity mismatch');
  if (!isAbsolute(webArchive) || !lstatSync(webArchive).isFile()) {
    throw new Error('Web archive must be an absolute regular file');
  }
  const webBytes = readFileSync(webArchive);
  const webPackage = inspectPeerArtifact(webBytes);
  if (webArtifact.schemaVersion !== 'dsh-workbench.web-artifact.v1'
    || webArtifact.releaseVersion !== contract.release.version
    || webArtifact.name !== '@sympoies/dsh-workbench-web'
    || !sha256.test(webArtifact.artifactSha256)) {
    throw new Error('Web artifact record does not match Workbench contract');
  }
  if (webPackage.name !== '@sympoies/dsh-workbench-web'
    || webPackage.version !== contract.release.version) {
    throw new Error('Web archive identity does not match Workbench contract');
  }
  if (webPackage.artifactSha256 !== expectedWebArtifactSha256) {
    throw new Error('Web archive digest does not match reviewed artifact');
  }
  if (!isAbsolute(cliArchive) || !lstatSync(cliArchive).isFile()) {
    throw new Error('Official CLI archive must be an absolute regular file');
  }
  const cliBytes = readFileSync(cliArchive);
  if (`sha512-${createHash('sha512').update(cliBytes).digest('base64')}` !== expectedCliIntegrity) {
    throw new Error('Official CLI archive integrity mismatch');
  }
  const cliPackage = inspectPeerArtifact(cliBytes);
  if (cliPackage.name !== contract.components.dsh.package.name
    || cliPackage.version !== contract.components.dsh.package.version) {
    throw new Error('Official CLI archive identity mismatch');
  }
  if (!isAbsolute(providerArchive) || !lstatSync(providerArchive, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Provider archive must be an absolute regular file');
  }
  const providerBytes = readFileSync(providerArchive);
  if (`sha512-${createHash('sha512').update(providerBytes).digest('base64')}` !== expectedProviderIntegrity) {
    throw new Error('Provider archive integrity mismatch');
  }
  const provider = contract.components.codexSubscription.package;
  const providerPackage = inspectPeerArtifact(providerBytes);
  if (providerPackage.name !== provider.name || providerPackage.version !== provider.version) {
    throw new Error('Provider archive identity mismatch');
  }
  const dsh = contract.components.dsh;
  if (kitManifest.schema_version !== 'dsh-runtime-kit.dsh-compatibility.v1'
    || kitManifest.repository !== dsh.source.url
    || kitManifest.validated_releases?.[dsh.package.version]?.revision !== dsh.source.commit) {
    throw new Error('runtime-kit DSH revision does not match Workbench contract');
  }
  if (receipt.schema_version !== 'dsh-runtime-kit.dsh-peer-pack.v1'
    || receipt.ok !== true
    || receipt.data?.channel !== 'pinned'
    || receipt.data.revision !== dsh.source.commit
    || receipt.data.patch_state !== 'patched'
    || receipt.data.patch_id !== 'native-execution-boundaries-v5'
    || receipt.data.upstream_checkout_clean !== false
    || !Array.isArray(receipt.data.packages)) {
    throw new Error('runtime-kit patched peer receipt has the wrong identity');
  }
  const declared = kitManifest.workspace_artifacts;
  const publicPackages = kitManifest.public_packages;
  if (declared === null || typeof declared !== 'object' || publicPackages === null
    || typeof publicPackages !== 'object' || Object.keys(declared).length === 0
    || kitManifest.patched_workspace_artifacts === null
    || typeof kitManifest.patched_workspace_artifacts !== 'object') {
    throw new Error('runtime-kit patched DSH closure is missing');
  }
  const byName = new Map<string, Artifact>();
  const verifiedBytes = new Map<string, Buffer>();
  for (const row of receipt.data.packages) {
    if (byName.has(row.name)) throw new Error('duplicate patched DSH artifact');
    byName.set(row.name, row);
  }
  if (byName.size !== Object.keys(declared).length) throw new Error('patched DSH closure is incomplete');
  const sorted = Object.entries(declared).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, entry] of sorted) {
    const row = byName.get(name);
    if (row === undefined || row.version !== entry.version) throw new Error('patched DSH closure is mixed');
    artifactFile(name, row.version);
    if (!isAbsolute(row.path) || !sha256.test(row.tarball_sha256)
      || !sha256.test(row.artifact_sha256) || !lstatSync(row.path).isFile()) {
      throw new Error('patched DSH artifact is invalid');
    }
    const bytes = readFileSync(row.path);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const canonical = inspectPeerArtifact(bytes);
    const registry = kitManifest.registry_workspace_artifacts?.[name];
    if (registry && `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== registry.integrity) {
      throw new Error('registry artifact integrity mismatch');
    }
    const expected = kitManifest.patched_workspace_artifacts[name] ?? entry.artifact_sha256;
    if (!sha256.test(expected) || digest !== row.tarball_sha256
      || canonical.name !== name || canonical.version !== row.version
      || canonical.artifactSha256 !== row.artifact_sha256
      || canonical.artifactSha256 !== expected) {
      throw new Error('patched DSH artifact digest mismatch');
    }
    verifiedBytes.set(name, registry ? bytes : normalizePeerArtifact(bytes));
  }
  for (const name of Object.keys(publicPackages)) {
    if (!byName.has(name)) throw new Error('runtime-kit public package is outside patched DSH closure');
  }
  const rendered = spawnSync(process.execPath, [join(root, 'scripts/tui-compat.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  if (rendered.status !== 0 || !rendered.stdout.includes('overrides:\n')) {
    throw new Error('TUI compatibility settings could not be rendered');
  }
  const selected = sorted.filter(([name]) => {
    const platform = kitManifest.registry_workspace_artifacts?.[name]?.platform;
    return platform === undefined || platform === `${process.platform}-${process.arch}`;
  });
  // Root the official CLI and all compatible plugin owners in one profile.
  // Root the complete compatible closure so scope owners and consumers share
  // the same module instance instead of mixing profile and host registries.
  const dependencies = Object.fromEntries(selected.map(([name, entry]) => {
    return [name, `file:artifacts/${artifactFile(name, entry.version)}`];
  }));
  const tuiFile = `${contract.components.tui.package.name.slice(1).replace('/', '-')}-${contract.components.tui.package.version}.tgz`;
  const webFile = `sympoies-dsh-workbench-web-${contract.release.version}.tgz`;
  const cliFile = `${cliPackage.name.slice(1).replace('/', '-')}-${cliPackage.version}.tgz`;
  dependencies[cliPackage.name] = `file:artifacts/${cliFile}`;
  dependencies[contract.components.tui.package.name] = `file:artifacts/${tuiFile}`;
  dependencies[webPackage.name] = `file:artifacts/${webFile}`;
  const providerFile = `${provider.name.slice(1).replace('/', '-')}-${provider.version}.tgz`;
  dependencies[provider.name] = `file:artifacts/${providerFile}`;
  const overrides = selected.map(([name, entry]) =>
    `  '${name}': 'file:artifacts/${artifactFile(name, entry.version)}'`).join('\n');
  const workspace = rendered.stdout.replace('overrides:\n', `overrides:\n${overrides}\n`);
  const patch = contract.components.tui.compatibilityPatch!;
  const patchBytes = readFileSync(join(root, patch.path));
  if (createHash('sha256').update(patchBytes).digest('hex') !== patch.sha256) {
    throw new Error('TUI compatibility patch digest mismatch');
  }
  const manifest = {
    name: 'dsh-profile-workbench',
    private: true,
    dependencies,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
      contract.components.tui.package.name] } },
  };
  let createdProfile: { dev: number; ino: number } | undefined;
  try {
    mkdirSync(profile);
    const created = lstatSync(profile);
    createdProfile = { dev: created.dev, ino: created.ino };
    materializeTuiEntry(join(profile, 'workbench-tui'), contract.release.version);
    mkdirSync(join(profile, 'artifacts'));
    mkdirSync(join(profile, 'patches'));
    writeFileSync(join(profile, 'LICENSE'), readFileSync(join(root, 'LICENSE')), { flag: 'wx' });
    writeFileSync(join(profile, 'THIRD_PARTY_NOTICES.md'),
      readFileSync(join(root, 'THIRD_PARTY_NOTICES.md')), { flag: 'wx' });
    for (const [name, entry] of sorted) {
      writeFileSync(join(profile, 'artifacts', artifactFile(name, entry.version)),
        verifiedBytes.get(name)!, { flag: 'wx' });
    }
    writeFileSync(join(profile, 'artifacts', tuiFile), tuiBytes, { flag: 'wx' });
    writeFileSync(join(profile, 'artifacts', webFile), normalizePeerArtifact(webBytes), { flag: 'wx' });
    writeFileSync(join(profile, 'artifacts', cliFile), cliBytes, { flag: 'wx' });
    writeFileSync(join(profile, 'artifacts', providerFile), providerBytes, { flag: 'wx' });
    writeFileSync(join(profile, 'patches/tui-rename.patch'), patchBytes, { flag: 'wx' });
    writeFileSync(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), workspace);
    writeFileSync(join(profile, 'cordis.yml'), '[]\n');
    writeFileSync(join(profile, 'cordis.patch.yml'), WORKBENCH_PROFILE_PATCH);
  } catch (error) {
    if (createdProfile !== undefined) {
      const current = lstatSync(profile, { throwIfNoEntry: false });
      if (current?.isDirectory() && current.dev === createdProfile.dev
        && current.ino === createdProfile.ino) {
        rmSync(profile, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

/** Stage with the immutable kit manifest named by the Workbench contract. */
export function stageCombinedProfileFromPinnedKit(input: {
  dshHome: string;
  receipt: PeerReceipt;
  kitRepo: string;
  tuiArchive: string;
  webArchive: string;
  cliArchive: string;
  providerArchive: string;
}, gitExecutable = '/usr/bin/git'): void {
  if (!isAbsolute(input.dshHome)
    || !lstatSync(join(input.dshHome, 'profiles'), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('DSH home must have an absolute profiles directory');
  }
  const kitManifest = readPinnedKitJson(input.kitRepo, 'compatibility/dsh.json', gitExecutable) as KitManifest;
  stageCombinedProfile({ profile: join(input.dshHome, 'profiles', 'workbench'), receipt: input.receipt, kitManifest,
    tuiArchive: input.tuiArchive, webArchive: input.webArchive, cliArchive: input.cliArchive,
    providerArchive: input.providerArchive });
}
