import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLinuxInstall, planLinuxInstall, type LinuxInstallInput } from '../src/linux-installer.ts';
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
process.stdout.write(`${JSON.stringify({
  schemaVersion: 'dsh-workbench.owner-install-acceptance.v1',
  releaseVersion: installed.releaseVersion,
  archiveSha256: installed.archiveSha256,
  manifestSha256: installed.manifestSha256,
  planDigest: installed.planDigest,
  installedFaces: ['web', 'tui'],
  result: 'passed',
})}\n`);
