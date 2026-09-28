import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync,
  symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { applyLinuxInstall, nodeMeetsBaseline, planLinuxInstall, preparePnpmEnvironment,
  runInstallerCommand,
  type LinuxInstallInput } from '../src/linux-installer.ts';
import { hashOwnerFile, ownerPackageTreeSha256 } from '../src/linux-owner-input.ts';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const accepted = JSON.parse(readFileSync(new URL('../compatibility/workbench.json', import.meta.url),
  'utf8')).status === 'accepted';

test('a Linux install plan binds exact inputs without writing an installation', { skip: !accepted }, () => {
  const parent = mkdtempSync(join(tmpdir(), 'workbench-install-plan-'));
  try {
    const archive = join(parent, 'candidate.tar.gz');
    const ownerConfig = join(parent, 'owner.json');
    const pnpmPackageRoot = join(parent, 'pnpm-package');
    mkdirSync(pnpmPackageRoot);
    const pnpmExecutable = join(pnpmPackageRoot, 'pnpm.cjs');
    const installRoot = join(parent, 'installed');
    const bytes = Buffer.from('candidate archive fixture');
    writeFileSync(archive, bytes, { mode: 0o600 });
    writeFileSync(pnpmExecutable, 'process.stdout.write("11.24.0\\n")\n', { mode: 0o600 });
    writeFileSync(ownerConfig, JSON.stringify({
      schemaVersion: 'dsh-workbench.owner-environment.v1',
      environment: { DEEPSEEK_BASE_URL: 'https://example.invalid/v1' },
      secretFiles: {},
    }), { mode: 0o600 });
    const input: LinuxInstallInput = {
      schemaVersion: 'dsh-workbench.linux-install-input.v1',
      archivePath: archive,
      archiveSha256: sha256(bytes),
      manifestSha256: 'a'.repeat(64),
      runtimeKitRepo: parent,
      pnpmExecutable, pnpmSha256: sha256(readFileSync(pnpmExecutable)),
      pnpmPackageRoot, pnpmPackageSha256: ownerPackageTreeSha256(pnpmPackageRoot, pnpmExecutable),
      installRoot,
      ownerEnvironmentFile: ownerConfig,
    };
    const first = planLinuxInstall(input);
    assert.match(first.planDigest, /^[a-f0-9]{64}$/);
    assert.equal(first.archiveSha256, input.archiveSha256);
    assert.equal(existsSync(installRoot), false);
    assert.deepEqual(planLinuxInstall(input), first);
    assert.throws(() => applyLinuxInstall(input, '0'.repeat(64)), /plan digest/);
    assert.equal(existsSync(installRoot), false);
    writeFileSync(ownerConfig, readFileSync(ownerConfig) + '\n', { mode: 0o600 });
    assert.notEqual(planLinuxInstall(input).planDigest, first.planDigest);
    assert.equal(existsSync(installRoot), false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('Linux install planning refuses a stale archive, existing target, or unsafe owner input',
  { skip: !accepted }, () => {
  const parent = mkdtempSync(join(tmpdir(), 'workbench-install-refusal-'));
  try {
    const archive = join(parent, 'candidate.tar.gz');
    const ownerConfig = join(parent, 'owner.json');
    const pnpmPackageRoot = join(parent, 'pnpm-package');
    mkdirSync(pnpmPackageRoot);
    const pnpmExecutable = join(pnpmPackageRoot, 'pnpm.cjs');
    const installRoot = join(parent, 'installed');
    const bytes = Buffer.from('candidate archive fixture');
    writeFileSync(archive, bytes, { mode: 0o600 });
    writeFileSync(pnpmExecutable, 'process.stdout.write("11.24.0\\n")\n', { mode: 0o600 });
    writeFileSync(ownerConfig, JSON.stringify({
      schemaVersion: 'dsh-workbench.owner-environment.v1', environment: {}, secretFiles: {},
    }), { mode: 0o600 });
    const input: LinuxInstallInput = {
      schemaVersion: 'dsh-workbench.linux-install-input.v1',
      archivePath: archive, archiveSha256: sha256(bytes),
      manifestSha256: 'b'.repeat(64), runtimeKitRepo: parent,
      pnpmExecutable, pnpmSha256: sha256(readFileSync(pnpmExecutable)),
      pnpmPackageRoot, pnpmPackageSha256: ownerPackageTreeSha256(pnpmPackageRoot, pnpmExecutable),
      installRoot, ownerEnvironmentFile: ownerConfig,
    };
    assert.throws(() => planLinuxInstall({ ...input, archiveSha256: '0'.repeat(64) }),
      /archive digest/);
    assert.throws(() => planLinuxInstall({ ...input, pnpmSha256: '0'.repeat(64) }),
      /pnpm executable digest/);
    assert.throws(() => planLinuxInstall({ ...input, pnpmPackageSha256: '0'.repeat(64) }),
      /pnpm package tree digest/);
    mkdirSync(installRoot);
    assert.throws(() => planLinuxInstall(input), /install root already exists/);
    rmSync(installRoot, { recursive: true });
    writeFileSync(ownerConfig, JSON.stringify({
      schemaVersion: 'dsh-workbench.owner-environment.v1',
      environment: { DSH_RUNTIME_KIT_AGENT_HOOK_BIN: '/tmp/fake' }, secretFiles: {},
    }), { mode: 0o600 });
    assert.throws(() => planLinuxInstall(input), /owner environment/);
    const blankSecret = join(parent, 'blank-secret');
    writeFileSync(blankSecret, '\n', { mode: 0o600 });
    writeFileSync(ownerConfig, JSON.stringify({
      schemaVersion: 'dsh-workbench.owner-environment.v1',
      environment: {}, secretFiles: { DEEPSEEK_API_KEY: blankSecret },
    }), { mode: 0o600 });
    assert.throws(() => planLinuxInstall(input), /secret reference/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('a candidate contract cannot create an owner install plan', { skip: accepted }, () => {
  const input: LinuxInstallInput = {
    schemaVersion: 'dsh-workbench.linux-install-input.v1', archivePath: '',
    archiveSha256: '', manifestSha256: '', runtimeKitRepo: '',
    pnpmExecutable: '', pnpmSha256: '', pnpmPackageRoot: '', pnpmPackageSha256: '',
    installRoot: '', ownerEnvironmentFile: '',
  };
  assert.throws(() => planLinuxInstall(input), /accepted contract/);
});

test('pnpm package closure binds sibling code and Node baseline compares numeric components', () => {
  const parent = mkdtempSync(join(tmpdir(), 'workbench-pnpm-tree-'));
  try {
    const packageRoot = join(parent, 'pnpm-package');
    mkdirSync(packageRoot);
    const executable = join(packageRoot, 'pnpm.cjs');
    const sibling = join(packageRoot, 'module.cjs');
    writeFileSync(executable, 'require("./module.cjs")\n', { mode: 0o600 });
    writeFileSync(sibling, 'module.exports = 1\n', { mode: 0o600 });
    const original = ownerPackageTreeSha256(packageRoot, executable);
    writeFileSync(sibling, 'module.exports = 2\n', { mode: 0o600 });
    assert.notEqual(ownerPackageTreeSha256(packageRoot, executable), original);
    assert.equal(nodeMeetsBaseline('24.3.0', '>=24.3.0'), true);
    assert.equal(nodeMeetsBaseline('24.2.99', '>=24.3.0'), false);
    assert.equal(nodeMeetsBaseline('25.0.0', '>=24.3.0'), true);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('archive planning hashes through a bounded owner descriptor', () => {
  const parent = mkdtempSync(join(tmpdir(), 'workbench-archive-hash-'));
  try {
    const archive = join(parent, 'archive.tar.gz');
    const bytes = Buffer.from('reviewed archive fixture');
    writeFileSync(archive, bytes, { mode: 0o600 });
    assert.equal(hashOwnerFile(archive, 'install archive', 512 * 1024 * 1024), sha256(bytes));
    truncateSync(archive, 512 * 1024 * 1024 + 1);
    assert.throws(() => hashOwnerFile(archive, 'install archive', 512 * 1024 * 1024),
      /exceeds maximum/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('frozen pnpm installation receives no ambient executable configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-pnpm-environment-'));
  const previous = process.env.NPM_CONFIG_GLOBAL_PNPMFILE;
  process.env.NPM_CONFIG_GLOBAL_PNPMFILE = join(root, 'untrusted-pnpmfile.cjs');
  try {
    const environment = preparePnpmEnvironment(root, {
      schemaVersion: 'dsh-workbench.owner-environment.v1',
      environment: { HTTPS_PROXY: 'http://proxy.example.invalid:8080' },
      secretFiles: {},
    });
    assert.equal(environment.NPM_CONFIG_GLOBAL_PNPMFILE, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.PNPM_HOME, undefined);
    assert.equal(environment.HTTPS_PROXY, 'http://proxy.example.invalid:8080');
    assert.equal(readFileSync(environment.NPM_CONFIG_USERCONFIG!, 'utf8'), '');
    assert.equal(environment.NPM_CONFIG_GLOBALCONFIG, environment.NPM_CONFIG_USERCONFIG);
    assert.ok(environment.HOME?.startsWith(root));
  } finally {
    if (previous === undefined) delete process.env.NPM_CONFIG_GLOBAL_PNPMFILE;
    else process.env.NPM_CONFIG_GLOBAL_PNPMFILE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('install entrypoint refuses unsafe input path before planning', () => {
  const parent = mkdtempSync(join(tmpdir(), 'workbench-input-'));
  try {
    const input = join(parent, 'input.json');
    const alias = join(parent, 'alias.json');
    const entry = new URL('../scripts/linux-install.mjs', import.meta.url).pathname;
    writeFileSync(input, '{}\n', { mode: 0o600 });
    const run = (path: string) => spawnSync(process.execPath, [entry, 'plan', path], {
      encoding: 'utf8', timeout: 10_000,
    });
    symlinkSync(input, alias);
    assert.match(run(alias).stderr, /ELOOP/);
    assert.match(run(`${parent}/../${basename(parent)}/input.json`).stderr, /absolute canonical file/);
    chmodSync(parent, 0o777);
    assert.match(run(input).stderr, /directory is not owner controlled/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('a timed-out installer command cannot leave a descendant that mutates later', () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-install-timeout-'));
  try {
    const marker = join(root, 'late-mutation');
    const command = join(root, 'spawn-descendant.cjs');
    writeFileSync(command, `const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(
  `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500)`) }],
  { stdio: 'ignore' });
setTimeout(() => {}, 10000);\n`, { mode: 0o600 });
    assert.throws(() => runInstallerCommand(process.execPath, [command], root,
      process.env, 'timeout fixture', 100), /timeout fixture/);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 650);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime-kit setup failure reports only its bounded diagnostic code', () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-setup-error-'));
  try {
    const failure = join(root, 'failure.cjs');
    writeFileSync(failure, `process.stdout.write(JSON.stringify({
  schema_version: 'cli.dsh-runtime-kit.operations.v1', ok: false,
  error: { code: 'toolchain-incompatible', message: 'private-token-must-not-leak' }
})); process.exit(70);\n`, { mode: 0o600 });
    assert.throws(() => runInstallerCommand(process.execPath, [failure], root,
      process.env, 'runtime-kit setup'), error => {
      assert.match(String(error), /toolchain-incompatible/);
      assert.doesNotMatch(String(error), /private-token-must-not-leak/);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
