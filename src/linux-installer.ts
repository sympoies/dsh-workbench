import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, lstatSync, mkdirSync, readFileSync,
  realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkbenchContract } from './contract-types.ts';
import { extractLinuxReleaseArchive } from './linux-release-archive.ts';
import { verifyLinuxReleaseContents } from './linux-release-content.ts';
import type { LinuxReleaseManifest } from './linux-release-manifest.ts';
import { hashOwnerFile, ownerPackageTreeSha256, readOwnerEnvironment, readOwnerFile,
  type OwnerEnvironment } from './linux-owner-input.ts';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(new URL('../compatibility/workbench.json', import.meta.url), 'utf8')) as WorkbenchContract;
const digest = /^[a-f0-9]{64}$/;
const managedEnvironment = new Set(['DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export type LinuxInstallInput = {
  schemaVersion: 'dsh-workbench.linux-install-input.v1';
  archivePath: string;
  archiveSha256: string;
  manifestSha256: string;
  runtimeKitRepo: string;
  pnpmExecutable: string;
  pnpmSha256: string;
  pnpmPackageRoot: string;
  pnpmPackageSha256: string;
  installRoot: string;
  ownerEnvironmentFile: string;
};

export type LinuxInstallPlan = {
  schemaVersion: 'dsh-workbench.linux-install-plan.v1';
  releaseVersion: string;
  archiveSha256: string;
  manifestSha256: string;
  ownerEnvironmentSha256: string;
  pnpmSha256: string;
  pnpmPackageSha256: string;
  nodeVersion: string;
  installRoot: string;
  planDigest: string;
};

function exactKeys(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has unexpected fields`);
  }
  return value as Record<string, unknown>;
}

export function nodeMeetsBaseline(actual: string, requirement: string): boolean {
  const floor = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(requirement);
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(actual);
  if (!floor || !version) return false;
  for (let index = 1; index <= 3; index++) {
    const left = Number(version[index]);
    const right = Number(floor[index]);
    if (left !== right) return left > right;
  }
  return true;
}

/** Inspect exact owner inputs and archive bytes without creating an installation. */
export function planLinuxInstall(input: LinuxInstallInput): LinuxInstallPlan {
  exactKeys(input, ['schemaVersion', 'archivePath', 'archiveSha256', 'manifestSha256',
    'runtimeKitRepo', 'pnpmExecutable', 'pnpmSha256', 'pnpmPackageRoot',
    'pnpmPackageSha256', 'installRoot', 'ownerEnvironmentFile'], 'Linux install input');
  if (input.schemaVersion !== 'dsh-workbench.linux-install-input.v1'
    || process.platform !== 'linux' || process.arch !== 'x64'
    || contract.status !== 'accepted' || JSON.stringify(contract.runtime.platforms) !== '["linux-x64"]') {
    throw new Error('Linux x64 install input or accepted contract is unavailable');
  }
  if (!nodeMeetsBaseline(process.versions.node, contract.runtime.node)) {
    throw new Error('Linux install Node runtime is below the contract baseline');
  }
  if (!digest.test(input.archiveSha256) || !digest.test(input.manifestSha256)) {
    throw new Error('install archive or manifest digest is invalid');
  }
  if (!digest.test(input.pnpmSha256)
    || sha256(readOwnerFile(input.pnpmExecutable, 'pnpm executable')) !== input.pnpmSha256) {
    throw new Error('pnpm executable digest differs');
  }
  if (!digest.test(input.pnpmPackageSha256)
    || ownerPackageTreeSha256(input.pnpmPackageRoot, input.pnpmExecutable)
      !== input.pnpmPackageSha256) {
    throw new Error('pnpm package tree digest differs');
  }
  if (hashOwnerFile(input.archivePath, 'install archive', 512 * 1024 * 1024)
    !== input.archiveSha256) {
    throw new Error('install archive digest differs');
  }
  if (!isAbsolute(input.runtimeKitRepo) || resolve(input.runtimeKitRepo) !== input.runtimeKitRepo) {
    throw new Error('runtime-kit source path is invalid');
  }
  const kit = lstatSync(input.runtimeKitRepo, { throwIfNoEntry: false });
  if (!kit?.isDirectory() || kit.uid !== process.getuid?.()
    || realpathSync(input.runtimeKitRepo) !== input.runtimeKitRepo) {
    throw new Error('runtime-kit source is not owner controlled');
  }
  if (!isAbsolute(input.installRoot) || resolve(input.installRoot) !== input.installRoot) {
    throw new Error('install root is not an absolute canonical path');
  }
  if (lstatSync(input.installRoot, { throwIfNoEntry: false })) {
    throw new Error('install root already exists');
  }
  const parent = dirname(input.installRoot);
  const parentStat = lstatSync(parent, { throwIfNoEntry: false });
  if (!parentStat?.isDirectory() || parentStat.uid !== process.getuid?.()
    || realpathSync(parent) !== parent || (parentStat.mode & 0o022) !== 0) {
    throw new Error('install root parent is not owner controlled');
  }
  const owner = readOwnerEnvironment(input.ownerEnvironmentFile);
  const stable = {
    schemaVersion: 'dsh-workbench.linux-install-plan.v1' as const,
    releaseVersion: contract.release.version,
    archiveSha256: input.archiveSha256,
    manifestSha256: input.manifestSha256,
    ownerEnvironmentSha256: owner.rawSha256,
    pnpmSha256: input.pnpmSha256,
    pnpmPackageSha256: input.pnpmPackageSha256,
    nodeVersion: process.versions.node,
    installRoot: input.installRoot,
  };
  return { ...stable, planDigest: sha256(JSON.stringify({ ...stable,
    archivePath: input.archivePath, runtimeKitRepo: input.runtimeKitRepo,
    pnpmExecutable: input.pnpmExecutable,
    pnpmPackageRoot: input.pnpmPackageRoot,
    ownerEnvironmentFile: input.ownerEnvironmentFile, sourceRoot })) };
}

class UnprovenSubprocessCleanup extends Error {}

function processGroupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new UnprovenSubprocessCleanup('installer process-group state is unknown; retain install root for recovery');
  }
}

function runContained(executable: string, args: string[], cwd: string,
  environment: NodeJS.ProcessEnv, label: string, timeout: number,
  input?: string) {
  const result = spawnSync('/usr/bin/setsid', [executable, ...args], {
    cwd, env: environment, encoding: 'utf8', timeout, input,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.pid && processGroupExists(result.pid)) {
    try { process.kill(-result.pid, 'SIGKILL'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw new UnprovenSubprocessCleanup(`${label} descendants could not be stopped; retain install root for recovery`);
      }
    }
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 40 && processGroupExists(result.pid); attempt++) {
      Atomics.wait(pause, 0, 0, 50);
    }
    if (processGroupExists(result.pid)) {
      throw new UnprovenSubprocessCleanup(`${label} descendants may remain; retain install root for recovery`);
    }
    throw new Error(`${label} left running descendants`);
  }
  return result;
}

export function runInstallerCommand(executable: string, args: string[], cwd: string,
  environment: NodeJS.ProcessEnv, label: string, timeout = 300_000): string {
  const result = runContained(executable, args, cwd, environment, label, timeout);
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status ?? 'unknown'}`);
  }
  return result.stdout;
}

function runtimeEnvironment(root: string, config: Record<string, string>,
  owner: OwnerEnvironment): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('AGENT_SESSION_') || managedEnvironment.has(key)) delete environment[key];
  }
  Object.assign(environment, owner.environment);
  Object.assign(environment, {
    DSH_HOME: config.dshHome,
    CODEX_HOME: config.codexHome,
    CLAUDE_CONFIG_DIR: config.claudeConfigDir,
    XDG_CONFIG_HOME: config.configHome,
    XDG_STATE_HOME: config.stateHome,
    DSH_RUNTIME_KIT_DSH_BIN: config.dshDirectBin,
    DSH_RUNTIME_KIT_AGENT_HOOK_BIN: config.agentHookBin,
    DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG: config.hookConfig,
    DSH_RUNTIME_KIT_AGENT_HOOK_POLICY: config.hookPolicy,
    DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR: join(root, 'state/agent-hook-dsh'),
    DSH_RUNTIME_KIT_AGENT_DOCS_BIN: config.agentDocsBin,
    DSH_RUNTIME_KIT_AGENT_DOCS_HOME: config.agentDocsHome,
    DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME: join(root, 'state/agent-docs-dsh'),
    DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR: config.privateSkillsDir,
  });
  return environment;
}

/** Give the reviewed pnpm bytes only a private, empty configuration namespace. */
export function preparePnpmEnvironment(root: string, owner: OwnerEnvironment): NodeJS.ProcessEnv {
  const home = join(root, 'package-manager-home');
  const configHome = join(root, 'package-manager-config');
  const cacheHome = join(root, 'package-manager-cache');
  for (const path of [home, configHome, cacheHome]) mkdirSync(path, { mode: 0o700 });
  const npmrc = join(configHome, 'npmrc');
  writeFileSync(npmrc, '', { flag: 'wx', mode: 0o600 });
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: cacheHome,
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_GLOBALCONFIG: npmrc,
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: npmrc,
    CI: 'true',
  };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] as const) {
    const value = owner.environment[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function probeHost(agentHook: string, root: string): void {
  const result = runContained(agentHook, ['finish-line', 'open', '--format', 'json'],
    root, process.env, 'finish-line host probe', 30_000, JSON.stringify({
      schema_version: 'agent-hook.finish-line.open.v1', product: 'dsh',
      session_id: `workbench-install-probe-${randomUUID()}`, turn_id: 'turn-1',
      cwd: root, attempt_token: randomUUID(),
    }));
  let response: { schema_version?: string; error?: { code?: string } } = {};
  try { response = JSON.parse(result.stdout); } catch { /* an invalid response remains a failure */ }
  if (result.error || result.status !== 65
    || response.schema_version !== 'cli.agent-hook.finish-line-open.v1'
    || response.error?.code !== 'finish-line-not-in-repository') {
    throw new Error('authoritative Linux finish-line host probe failed');
  }
}

function verifyInstallerSource(commit: string, tree: string): void {
  const git = (args: string[]): string => runInstallerCommand('/usr/bin/git',
    ['-C', sourceRoot, ...args], sourceRoot, process.env,
    'installer source authentication', 15_000).trim();
  if (git(['rev-parse', 'HEAD']) !== commit || git(['rev-parse', 'HEAD^{tree}']) !== tree
    || git(['status', '--porcelain', '--untracked-files=all']) !== '') {
    throw new Error('installer checkout differs from the release builder source');
  }
}

function setupRuntime(root: string, kitPackage: string, config: Record<string, string>,
  owner: OwnerEnvironment): string {
  const launcher = join(kitPackage, 'dist/bin/dsh-runtime-kit-launch.js');
  const cli = join(kitPackage, 'dist/bin/dsh-runtime-kit.js');
  const environment = runtimeEnvironment(root, config, owner);
  const call = (action: string, extra: string[]): Record<string, unknown> => {
    const output = runInstallerCommand(process.execPath,
      [launcher, '--runtime-root', config.runtimeRoot, '--', process.execPath,
        cli, action, '--profile', 'workbench', ...extra, '--format', 'json'],
      root, environment, `runtime-kit ${action}`, 180_000);
    const parsed = JSON.parse(output) as { ok?: boolean; data?: Record<string, unknown> };
    if (!parsed.ok || !parsed.data) throw new Error(`runtime-kit ${action} returned an invalid receipt`);
    return parsed.data;
  };
  const preview = call('setup', ['--package', kitPackage]);
  const planDigest = preview.plan_digest;
  if (preview.mode !== 'dry-run' || typeof planDigest !== 'string' || !digest.test(planDigest)) {
    throw new Error('runtime-kit setup did not produce a bounded plan');
  }
  const applied = call('setup', ['--package', kitPackage,
    '--apply', '--expected-plan-digest', planDigest]);
  if (applied.mode !== 'applied') throw new Error('runtime-kit setup did not apply the exact plan');
  const doctor = call('doctor', []);
  if (doctor.profile !== 'workbench' || doctor.status !== 'healthy'
    || !Array.isArray(doctor.advisories) || doctor.advisories.length !== 0) {
    throw new Error('runtime-kit doctor is not healthy');
  }
  return planDigest;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export type LinuxInstallReceipt = {
  schemaVersion: 'dsh-workbench.linux-installed-unit.v1';
  releaseVersion: string;
  archiveSha256: string;
  manifestSha256: string;
  planDigest: string;
  ownerEnvironmentSha256: string;
  pnpmSha256: string;
  pnpmPackageSha256: string;
  nodeVersion: string;
  graphSha256: string;
  builderSourceCommit: string;
  profileLockSha256: string;
  runtimeKitPlanDigest: string;
  finishLineHostProbe: 'available';
  runtimeKitDoctor: 'healthy';
  productAccepted: false;
  installRoot: string;
  webLauncher: string;
  tuiLauncher: string;
};

/** Apply the unchanged plan into one new private root, or remove that root on failure. */
export function applyLinuxInstall(input: LinuxInstallInput,
  expectedPlanDigest: string): LinuxInstallReceipt {
  const plan = planLinuxInstall(input);
  if (!digest.test(expectedPlanDigest) || plan.planDigest !== expectedPlanDigest) {
    throw new Error('Linux install plan digest differs');
  }
  const root = input.installRoot;
  let created = false;
  try {
    mkdirSync(root, { mode: 0o700 });
    created = true;
    chmodSync(root, 0o700);
    const releaseRoot = join(root, 'release');
    extractLinuxReleaseArchive(input.archivePath, input.archiveSha256, releaseRoot);
    const content = verifyLinuxReleaseContents(releaseRoot, input.manifestSha256, input.runtimeKitRepo);
    const manifest = JSON.parse(readFileSync(join(releaseRoot, 'release-manifest.json'), 'utf8')) as LinuxReleaseManifest;
    if (content.releaseVersion !== plan.releaseVersion) throw new Error('install release version differs');
    verifyInstallerSource(manifest.builderSource.commit, manifest.builderSource.tree);
    const profile = join(root, 'dsh-home/profiles/workbench');
    mkdirSync(dirname(profile), { recursive: true, mode: 0o700 });
    cpSync(join(releaseRoot, 'profile'), profile, { recursive: true, errorOnExist: true });
    if (sha256(readOwnerFile(input.pnpmExecutable, 'pnpm executable')) !== input.pnpmSha256
      || ownerPackageTreeSha256(input.pnpmPackageRoot, input.pnpmExecutable)
        !== input.pnpmPackageSha256) {
      throw new Error('pnpm executable changed after the install plan');
    }
    const pnpmOwner = readOwnerEnvironment(input.ownerEnvironmentFile);
    if (pnpmOwner.rawSha256 !== plan.ownerEnvironmentSha256) {
      throw new Error('owner environment changed before frozen install');
    }
    const pnpmEnvironment = preparePnpmEnvironment(root, pnpmOwner.config);
    const pnpmVersion = runInstallerCommand(process.execPath, [input.pnpmExecutable, '--version'],
      root, pnpmEnvironment, 'pnpm version').trim();
    if (pnpmVersion !== contract.runtime.pnpm) throw new Error('pnpm version differs from contract');
    if (ownerPackageTreeSha256(input.pnpmPackageRoot, input.pnpmExecutable)
      !== input.pnpmPackageSha256) throw new Error('pnpm package changed before frozen install');
    runInstallerCommand(process.execPath, [input.pnpmExecutable, '--dir', profile, 'install', '--frozen-lockfile',
      '--strict-peer-dependencies', '--ignore-scripts', '--ignore-pnpmfile'],
    root, pnpmEnvironment, 'frozen profile install');
    if (!readFileSync(join(profile, 'pnpm-lock.yaml'))
      .equals(readFileSync(join(releaseRoot, 'profile/pnpm-lock.yaml')))) {
      throw new Error('frozen install changed the reviewed lockfile');
    }
    const kitPackageRoot = join(root, 'runtime-kit');
    mkdirSync(kitPackageRoot, { mode: 0o700 });
    runInstallerCommand('/usr/bin/tar', ['-xzf', join(releaseRoot, 'runtime-kit/package.tgz'),
      '-C', kitPackageRoot, '--no-same-owner'], root, process.env, 'runtime-kit package extraction');
    const kitPackage = join(kitPackageRoot, 'package');
    const agentDocsHome = join(root, 'agent-docs');
    const configHome = join(root, 'config');
    const stateHome = join(root, 'state');
    const binDir = join(root, 'bin');
    for (const path of [agentDocsHome, configHome, stateHome, binDir,
      join(configHome, 'agent-hook'), join(root, 'codex'), join(root, 'claude'),
      join(root, 'private-skills'), join(root, 'runtime')]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    for (const name of ['AGENT_DOCS.toml', 'PROJECT_DEV_EDIT.md']) {
      copyFileSync(join(kitPackage, 'agent-docs', name), join(agentDocsHome, name));
    }
    const hookPolicy = join(kitPackage, 'policy/dsh-runtime-kit-v1.toml');
    const hookConfig = join(configHome, 'agent-hook/config.toml');
    writeFileSync(hookConfig,
      `schema_version = "agent-hook.config.v1"\n\n[policy]\npath = ${JSON.stringify(hookPolicy)}\ndigest = "sha256:${sha256(readFileSync(hookPolicy))}"\n`,
      { flag: 'wx', mode: 0o600 });
    const dshCli = join(profile, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
    const dshDirectBin = join(binDir, 'dsh-direct');
    writeFileSync(dshDirectBin,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(dshCli)} "$@"\n`,
      { flag: 'wx', mode: 0o700 });
    chmodSync(dshDirectBin, 0o700);
    const config = {
      schemaVersion: 'dsh-workbench.linux-launch.v1',
      ownerEnvironmentFile: input.ownerEnvironmentFile,
      runtimeRoot: join(root, 'runtime'), kitPackage, dshCli,
      tuiEntry: join(profile, 'workbench-tui/scripts/launch-workbench-tui.ts'),
      dshHome: join(root, 'dsh-home'), codexHome: join(root, 'codex'),
      claudeConfigDir: join(root, 'claude'), configHome, stateHome,
      privateSkillsDir: join(root, 'private-skills'), agentDocsHome,
      hookConfig, hookPolicy,
      agentHookBin: join(releaseRoot, 'nils/bin/agent-hook'),
      agentDocsBin: join(releaseRoot, 'nils/bin/agent-docs'), dshDirectBin,
    };
    const launchConfig = join(root, 'launch-config.json');
    writeFileSync(launchConfig, `${JSON.stringify(config)}\n`, { flag: 'wx', mode: 0o600 });
    const launchSource = join(releaseRoot, 'installer/src/linux-installed-launch.ts');
    const installedLaunch = join(binDir, 'launch.ts');
    copyFileSync(launchSource, installedLaunch);
    copyFileSync(join(releaseRoot, 'installer/src/linux-owner-input.ts'),
      join(binDir, 'linux-owner-input.ts'));
    probeHost(config.agentHookBin, root);
    const refreshedOwner = readOwnerEnvironment(input.ownerEnvironmentFile);
    if (refreshedOwner.rawSha256 !== plan.ownerEnvironmentSha256) {
      throw new Error('owner environment changed after the install plan');
    }
    const owner = refreshedOwner.config;
    const runtimeKitPlanDigest = setupRuntime(root, kitPackage, config, owner);
    const launcher = (face: 'web' | 'tui'): string => {
      const path = join(binDir, `workbench-${face}`);
      writeFileSync(path,
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(installedLaunch)} ${shellQuote(launchConfig)} ${face} "$@"\n`,
        { flag: 'wx', mode: 0o700 });
      chmodSync(path, 0o700);
      return path;
    };
    const webLauncher = launcher('web');
    const tuiLauncher = launcher('tui');
    const receipt: LinuxInstallReceipt = {
      schemaVersion: 'dsh-workbench.linux-installed-unit.v1',
      releaseVersion: content.releaseVersion,
      archiveSha256: input.archiveSha256,
      manifestSha256: input.manifestSha256,
      planDigest: plan.planDigest,
      ownerEnvironmentSha256: plan.ownerEnvironmentSha256,
      pnpmSha256: input.pnpmSha256,
      pnpmPackageSha256: input.pnpmPackageSha256,
      nodeVersion: plan.nodeVersion,
      graphSha256: manifest.graphSha256,
      builderSourceCommit: manifest.builderSource.commit,
      profileLockSha256: content.profileLockSha256,
      runtimeKitPlanDigest,
      finishLineHostProbe: 'available', runtimeKitDoctor: 'healthy',
      productAccepted: false, installRoot: root, webLauncher, tuiLauncher,
    };
    writeFileSync(join(root, 'installed-unit-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 });
    return receipt;
  } catch (error) {
    if (created && !(error instanceof UnprovenSubprocessCleanup)) {
      rmSync(root, { recursive: true, force: true });
    }
    throw error;
  }
}
