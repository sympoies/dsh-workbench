import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SESSION_HOOKS, applyLinuxInstall, planLinuxInstall, type LinuxInstallInput } from '../src/linux-installer.ts';
import { ownerPackageTreeSha256 } from '../src/linux-owner-input.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const [root, kitRepo, receiptPath, pnpmExecutable, browserBin] = process.argv.slice(2);
if (process.argv.length !== 7 || [root, kitRepo, receiptPath, pnpmExecutable, browserBin]
  .some(path => !path || !isAbsolute(path) || resolve(path) !== path)) {
  throw new Error('usage: node scripts/verify-owner-install.ts PRIVATE_ROOT KIT_REPO BUILD_RECEIPT PNPM_CJS BROWSER_BIN');
}
const rootStat = lstatSync(root);
if (!rootStat.isDirectory() || rootStat.uid !== process.getuid?.()
  || (rootStat.mode & 0o077) !== 0 || realpathSync(root) !== root) {
  throw new Error('owner acceptance root must be private and canonical');
}
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const build = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
  archiveSha256: string; manifestSha256: string;
};
const ownerEnvironmentFile = join(root, 'owner-environment.json');
const keyFile = join(root, 'owner-test-key');
const inputPath = join(root, 'owner-install-input.json');
const installRoot = join(root, 'owner-installed');
const archivePath = join(root, 'linux-release-candidate.tar.gz');
writeFileSync(keyFile, 'disposable-test-key\n', { flag: 'wx', mode: 0o600 });
writeFileSync(ownerEnvironmentFile, `${JSON.stringify({
  schemaVersion: 'dsh-workbench.owner-environment.v1',
  environment: { DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1' },
  secretFiles: { DEEPSEEK_API_KEY: keyFile },
})}\n`, { flag: 'wx', mode: 0o600 });
const input: LinuxInstallInput = {
  schemaVersion: 'dsh-workbench.linux-install-input.v1',
  archivePath, archiveSha256: build.archiveSha256,
  manifestSha256: build.manifestSha256,
  runtimeKitRepo: kitRepo, pnpmExecutable, pnpmSha256: sha256(pnpmExecutable),
  pnpmPackageRoot: dirname(dirname(pnpmExecutable)),
  pnpmPackageSha256: ownerPackageTreeSha256(dirname(dirname(pnpmExecutable)), pnpmExecutable),
  installRoot, ownerEnvironmentFile,
};
writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const plan = planLinuxInstall(input);
assert.equal(plan.archiveSha256, build.archiveSha256);
const installed = applyLinuxInstall(input, plan.planDigest);
assert.equal(installed.planDigest, plan.planDigest);
assert.equal(installed.ownerEnvironmentSha256, plan.ownerEnvironmentSha256);
assert.equal(installed.productAccepted, false);
assert.deepEqual(JSON.parse(readFileSync(join(installRoot, 'installed-unit-receipt.json'), 'utf8')),
  installed);

const config = JSON.parse(readFileSync(join(installRoot, 'launch-config.json'), 'utf8')) as
  Record<string, string>;
const environment = {
  DSH_HOME: config.dshHome,
  CODEX_HOME: config.codexHome,
  CLAUDE_CONFIG_DIR: config.claudeConfigDir,
  XDG_CONFIG_HOME: config.configHome,
  XDG_STATE_HOME: config.stateHome,
  DSH_RUNTIME_KIT_DSH_BIN: config.dshDirectBin,
  DSH_RUNTIME_KIT_AGENT_HOOK_BIN: config.agentHookBin,
  DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG: config.hookConfig,
  DSH_RUNTIME_KIT_AGENT_HOOK_POLICY: config.hookPolicy,
  DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR: join(config.stateHome, 'agent-hook-dsh'),
  DSH_RUNTIME_KIT_AGENT_DOCS_BIN: config.agentDocsBin,
  DSH_RUNTIME_KIT_AGENT_DOCS_HOME: config.agentDocsHome,
  DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME: join(config.stateHome, 'agent-docs-dsh'),
  DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR: config.privateSkillsDir,
};
const runtimeEnvFile = join(installRoot, 'terminal-environment.json');
writeFileSync(runtimeEnvFile, `${JSON.stringify(environment)}\n`, { flag: 'wx', mode: 0o600 });
writeFileSync(join(config.dshHome, '.workbench-terminal-acceptance'),
  'disposable CI profile\n', { flag: 'wx', mode: 0o600 });

for (const launcher of [installed.webLauncher, installed.tuiLauncher]) {
  const result = spawnSync(launcher, ['--dump-config'], {
    cwd: repo, env: process.env, encoding: 'utf8', timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout.includes('@sympoies/dsh-workbench-web')) {
    throw new Error('installed Workbench launcher did not compose the accepted graph');
  }
}
for (const [script, args, timeout] of [
  ['tests/tui-terminal-acceptance.ts', [
    '--dsh-bin', installed.tuiLauncher, '--installed-dsh-home', config.dshHome,
    '--runtime-env-file', runtimeEnvFile, '--owner-environment-file', ownerEnvironmentFile,
  ], 600_000],
  ['tests/web-browser-acceptance.ts', [
    '--dsh-bin', installed.webLauncher, '--tui-bin', installed.tuiLauncher,
    '--browser-bin', browserBin, '--installed-dsh-home', config.dshHome,
    '--runtime-env-file', runtimeEnvFile, '--owner-environment-file', ownerEnvironmentFile,
    '--ci-no-browser-sandbox',
  ], 900_000],
] as const) {
  const result = spawnSync(process.execPath, [join(repo, script), ...args], {
    cwd: repo, env: process.env, encoding: 'utf8', timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw new Error(`installed owner ${script} acceptance failed with status ${result.status ?? 'unknown'}`);
  }
}
// After the interface acceptance, so its session inventory is unchanged: a managed
// pane mounts the exact installed hook surface and seeds an exact-ID
// Session V4 through the profile's own persistence backend before resuming it.
assert.equal(readFileSync(installed.agentSessionHooks, 'utf8'), AGENT_SESSION_HOOKS);
assert.equal(sha256(installed.agentSessionHooks), installed.agentSessionHooksSha256);
assert.equal(lstatSync(installed.agentSessionHooks).mode & 0o777, 0o600);
const paneBin = join(root, 'pane-nils');
mkdirSync(paneBin, { mode: 0o700 });
writeFileSync(join(paneBin, 'agent-session'), '#!/bin/sh\nexit 0\n', { flag: 'wx', mode: 0o700 });
chmodSync(join(paneBin, 'agent-session'), 0o700);
const paneWorkspace = join(root, 'seed-workspace');
mkdirSync(paneWorkspace, { mode: 0o700 });
const seedId = '6d2f1e9a-4b7c-4d3e-8f10-2a9b8c7d6e5f';
const seeded = spawnSync(installed.seedLauncher, ['--session-id', seedId], {
  cwd: paneWorkspace, encoding: 'utf8', timeout: 60_000,
  env: { ...process.env, AGENT_SESSION_ID: 'owner-acceptance', AGENT_SESSION_RUNTIME_ID: 'owner-runtime',
    AGENT_SESSION_BIN: join(paneBin, 'agent-session') },
});
if (seeded.error || seeded.status !== 0) throw new Error(`installed seed failed: ${seeded.stderr}`);
assert.deepEqual(JSON.parse(seeded.stdout),
  { schema_version: 'dsh-workbench.seed.v1', provider_session_id: seedId });
const sessionsRoot = join(config.dshHome, 'sessions');
assert.ok(readdirSync(sessionsRoot).some(project =>
  existsSync(join(sessionsRoot, project, seedId, 'session.v4.jsonl.zstd'))),
'installed seed did not create a Session V4 archive');
const unmanaged = spawnSync(installed.seedLauncher, ['--session-id', seedId], {
  cwd: paneWorkspace, encoding: 'utf8', timeout: 60_000,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_SESSION_'))),
});
assert.notEqual(unmanaged.status, 0, 'installed seed must refuse an unmanaged launch');

process.stdout.write(`${JSON.stringify({
  schemaVersion: 'dsh-workbench.owner-install-acceptance.v1',
  releaseVersion: installed.releaseVersion,
  archiveSha256: installed.archiveSha256,
  manifestSha256: installed.manifestSha256,
  planDigest: installed.planDigest,
  installedFaces: ['web', 'tui', 'seed'],
  result: 'passed',
})}\n`);
