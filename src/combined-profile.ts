import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkbenchContract } from './contract-types.ts';
import { readPinnedKitJson } from './pinned-kit.ts';
import { inspectPeerArtifact } from './package-artifact.ts';

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
};

const root = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(join(root, 'compatibility/workbench.json'), 'utf8')) as WorkbenchContract;
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
 * receipt. This function authenticates those archives and the pinned TUI
 * tarball before writing only relative artifact references.
 */
export function stageCombinedProfile(input: {
  profile: string;
  receipt: PeerReceipt;
  kitManifest: KitManifest;
  tuiArchive: string;
}, expectedTuiIntegrity = contract.components.tui.package.integrity): void {
  const { profile, receipt, kitManifest, tuiArchive } = input;
  if (!isAbsolute(profile)) throw new Error('profile target must be a new absolute path');
  if (!isAbsolute(tuiArchive) || !lstatSync(tuiArchive).isFile()) {
    throw new Error('TUI archive must be an absolute regular file');
  }
  const tuiBytes = readFileSync(tuiArchive);
  const tuiIntegrity = `sha512-${createHash('sha512').update(tuiBytes).digest('base64')}`;
  if (tuiIntegrity !== expectedTuiIntegrity) throw new Error('TUI archive integrity mismatch');
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
    const expected = kitManifest.patched_workspace_artifacts[name] ?? entry.artifact_sha256;
    if (!sha256.test(expected) || digest !== row.tarball_sha256
      || canonical.name !== name || canonical.version !== row.version
      || canonical.artifactSha256 !== row.artifact_sha256
      || canonical.artifactSha256 !== expected) {
      throw new Error('patched DSH artifact digest mismatch');
    }
    verifiedBytes.set(name, bytes);
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
  const dependencies = Object.fromEntries(Object.keys(publicPackages).sort().map(name => {
    const row = byName.get(name)!;
    return [name, `file:artifacts/${artifactFile(name, row.version)}`];
  }));
  const tuiFile = `${contract.components.tui.package.name.slice(1).replace('/', '-')}-${contract.components.tui.package.version}.tgz`;
  dependencies[contract.components.tui.package.name] = `file:artifacts/${tuiFile}`;
  const overrides = sorted.map(([name, entry]) =>
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
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', contract.components.tui.package.name] } },
  };
  let createdProfile: { dev: number; ino: number } | undefined;
  try {
    mkdirSync(profile);
    const created = lstatSync(profile);
    createdProfile = { dev: created.dev, ino: created.ino };
    mkdirSync(join(profile, 'artifacts'));
    mkdirSync(join(profile, 'patches'));
    for (const [name, entry] of sorted) {
      writeFileSync(join(profile, 'artifacts', artifactFile(name, entry.version)),
        verifiedBytes.get(name)!, { flag: 'wx' });
    }
    writeFileSync(join(profile, 'artifacts', tuiFile), tuiBytes, { flag: 'wx' });
    writeFileSync(join(profile, 'patches/tui-rename.patch'), patchBytes, { flag: 'wx' });
    writeFileSync(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), workspace);
    writeFileSync(join(profile, 'cordis.yml'), '[]\n');
    writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
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
}, gitExecutable = '/usr/bin/git'): void {
  if (!isAbsolute(input.dshHome)
    || !lstatSync(join(input.dshHome, 'profiles'), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('DSH home must have an absolute profiles directory');
  }
  const kitManifest = readPinnedKitJson(input.kitRepo, 'compatibility/dsh.json', gitExecutable) as KitManifest;
  stageCombinedProfile({ profile: join(input.dshHome, 'profiles', 'workbench'), receipt: input.receipt, kitManifest,
    tuiArchive: input.tuiArchive });
}
