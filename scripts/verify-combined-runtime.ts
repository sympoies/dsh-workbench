#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const [kitPackage, dshSource, dshHome, runtimeRoot, nilsBin] = process.argv.slice(2);
if ([kitPackage, dshSource, dshHome, runtimeRoot, nilsBin].some(value => !value || !isAbsolute(value))
  || process.argv.length !== 7) {
  process.stderr.write('Usage: node scripts/verify-combined-runtime.ts <packed-kit-dir> <patched-dsh-source> <dsh-home> <runtime-root> <nils-bin-dir>\n');
  process.exit(64);
}

const profile = join(dshHome, 'profiles', 'workbench');
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'dsh-profile-workbench');
assert.deepEqual(manifest.dsh.profile.bundles,
  ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui']);
const root = join(dirname(runtimeRoot), 'workbench-verification');
const configHome = join(root, 'config');
const stateHome = join(root, 'state');
const docsHome = join(root, 'agent-docs');
const policyPath = join(kitPackage, 'policy', 'dsh-runtime-kit-v1.toml');
const hookConfig = join(configHome, 'agent-hook', 'config.toml');
const wrapper = join(root, 'dsh-wrapper.mjs');
const wrapperFailure = join(root, 'dsh-wrapper-failure.log');
const dshCli = join(dshSource, 'apps', 'cli', 'lib', 'bin.js');
for (const directory of [runtimeRoot, root, configHome, stateHome, docsHome,
  join(configHome, 'agent-hook'), join(root, 'codex'), join(root, 'claude'),
  join(root, 'private-skills')]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
for (const name of ['AGENT_DOCS.toml', 'PROJECT_DEV_EDIT.md']) {
  copyFileSync(join(kitPackage, 'agent-docs', name), join(docsHome, name));
}
const policyDigest = createHash('sha256').update(readFileSync(policyPath)).digest('hex');
writeFileSync(hookConfig,
  `schema_version = "agent-hook.config.v1"\n\n[policy]\npath = ${JSON.stringify(policyPath)}\ndigest = "sha256:${policyDigest}"\n`,
  { mode: 0o600 });
writeFileSync(wrapper, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const result = spawnSync(process.execPath, [${JSON.stringify(dshCli)}, ...process.argv.slice(2)], {
  cwd: ${JSON.stringify(dshSource)}, env: process.env, encoding: 'utf8',
  maxBuffer: 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) writeFileSync(${JSON.stringify(wrapperFailure)},
  JSON.stringify({ stdout: (result.stdout ?? '').slice(-4096),
    stderr: (result.stderr ?? '').slice(-4096) }), { mode: 0o600 });
process.exitCode = result.status ?? 1;
`, { mode: 0o755 });
chmodSync(wrapper, 0o755);

const runtimeEnvironment = {
  DSH_HOME: dshHome,
  CODEX_HOME: join(root, 'codex'),
  CLAUDE_CONFIG_DIR: join(root, 'claude'),
  XDG_CONFIG_HOME: configHome,
  XDG_STATE_HOME: stateHome,
  DSH_RUNTIME_KIT_DSH_BIN: wrapper,
  DSH_RUNTIME_KIT_AGENT_HOOK_BIN: join(nilsBin, 'agent-hook'),
  DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG: hookConfig,
  DSH_RUNTIME_KIT_AGENT_HOOK_POLICY: policyPath,
  DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR: join(stateHome, 'agent-hook-dsh'),
  DSH_RUNTIME_KIT_AGENT_DOCS_BIN: join(nilsBin, 'agent-docs'),
  DSH_RUNTIME_KIT_AGENT_DOCS_HOME: docsHome,
  DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME: join(stateHome, 'agent-docs-dsh'),
  DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR: join(root, 'private-skills'),
};
const environment = { ...process.env, ...runtimeEnvironment };
writeFileSync(join(root, 'terminal-environment.json'), JSON.stringify(runtimeEnvironment), { mode: 0o600 });
const launcher = join(kitPackage, 'dist', 'bin', 'dsh-runtime-kit-launch.js');
const cli = join(kitPackage, 'dist', 'bin', 'dsh-runtime-kit.js');
function invoke(command: string, args: string[]): { [key: string]: unknown } {
  const result = spawnSync(process.execPath,
    [launcher, '--runtime-root', runtimeRoot, '--', process.execPath, cli,
      command, '--profile', 'workbench', ...args, '--format', 'json'],
    { env: environment, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    try {
      const diagnostic = JSON.parse(readFileSync(wrapperFailure, 'utf8'));
      process.stderr.write(`DSH command stdout: ${diagnostic.stdout}\n`);
      process.stderr.write(`DSH command stderr: ${diagnostic.stderr}\n`);
    } catch { /* failure occurred before DSH started */ }
    try {
      const logRoot = join(profile, '.plugin-manager', 'logs');
      const recent = readdirSync(logRoot)
        .map(name => ({ name, modified: statSync(join(logRoot, name)).mtimeMs }))
        .sort((a, b) => b.modified - a.modified)[0]?.name;
      if (recent) {
        const log = readFileSync(join(logRoot, recent, 'pnpm.log'), 'utf8');
        process.stderr.write(`DSH package-manager diagnostic: ${log.slice(-4096)}\n`);
      }
    } catch { /* failure occurred before pnpm started */ }
    throw new Error(`${command} failed with status ${result.status ?? 'unknown'}`);
  }
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data?.profile ?? parsed.data?.plan?.profile ?? 'workbench', 'workbench');
  return parsed.data;
}
const preview = invoke('setup', ['--package', kitPackage]);
assert.equal(preview.mode, 'dry-run');
assert.match(preview.plan_digest as string, /^[a-f0-9]{64}$/);
const applied = invoke('setup', ['--package', kitPackage,
  '--apply', '--expected-plan-digest', preview.plan_digest as string]);
assert.equal(applied.mode, 'applied');
const doctor = invoke('doctor', []);
assert.equal(doctor.profile, 'workbench');
assert.equal(doctor.status, 'healthy');
assert.deepEqual(doctor.advisories, []);
writeFileSync(join(dshHome, '.workbench-terminal-acceptance'), 'disposable CI profile\n', { mode: 0o600 });
const composition = spawnSync(process.execPath,
  [launcher, '--runtime-root', runtimeRoot, '--', wrapper,
    '--profile', 'workbench', '--dump-config'],
  { env: environment, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
if (composition.status !== 0) {
  process.stderr.write(composition.stdout ?? '');
  process.stderr.write(composition.stderr ?? '');
  throw new Error('Workbench DSH/TUI composition smoke failed');
}
assert.match(composition.stdout, /@deepseek-harness-tui\/dsh-tui/);
assert.match(composition.stdout, /@sympoies\/dsh-runtime-kit/);
process.stdout.write(JSON.stringify({
  schema_version: 'dsh-workbench.combined-runtime-verification.v1',
  ok: true, profile: 'workbench', status: 'healthy', composition: 'passed',
}) + '\n');
