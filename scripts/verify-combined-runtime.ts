#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { chromium } from 'playwright-core';
import { publicBrowserFailure } from '../src/browser-diagnostic.ts';
import { workbenchIdentity } from '../web/src/identity.ts';

const [kitPackage, dshSource, dshHome, runtimeRoot, nilsBin, browserBin] = process.argv.slice(2);
if ([kitPackage, dshSource, dshHome, runtimeRoot, nilsBin, browserBin]
  .some(value => !value || !isAbsolute(value)) || process.argv.length !== 8) {
  process.stderr.write('Usage: node scripts/verify-combined-runtime.ts <packed-kit-dir> <patched-dsh-source> <dsh-home> <runtime-root> <nils-bin-dir> <browser-bin>\n');
  process.exit(64);
}

const profile = join(dshHome, 'profiles', 'workbench');
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'dsh-profile-workbench');
assert.deepEqual(manifest.dsh.profile.bundles,
  ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-harness-tui/dsh-tui']);
const root = join(dirname(runtimeRoot), 'workbench-verification');
const workspace = join(root, 'workspace');
const configHome = join(root, 'config');
const stateHome = join(root, 'state');
const docsHome = join(root, 'agent-docs');
const policyPath = join(kitPackage, 'policy', 'dsh-runtime-kit-v1.toml');
const hookConfig = join(configHome, 'agent-hook', 'config.toml');
const wrapper = join(root, 'dsh-wrapper.mjs');
const wrapperFailure = join(root, 'dsh-wrapper-failure.log');
const dshCli = join(dshSource, 'apps', 'cli', 'lib', 'bin.js');
for (const directory of [runtimeRoot, root, workspace, configHome, stateHome, docsHome,
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

const environment = {
  ...process.env,
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
assert.match(composition.stdout, /@sympoies\/dsh-workbench-web/);

async function verifyActivatedWeb(apiKey: string): Promise<void> {
  const answer = 'ACTIVATED_WORKBENCH_WEB_OK';
  const mock = await startMockLlmServer({ sequence: ['success'], repeatLast: true,
    successText: answer, apiKey });
  const host = spawn(process.execPath, [launcher, '--runtime-root', runtimeRoot, '--',
    process.execPath, dshCli, '--profile', 'workbench', '--host', '127.0.0.1',
    '--no-open', '--port', '0'], {
    cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...environment, DEEPSEEK_BASE_URL: `${mock.baseURL}/v1`,
      DEEPSEEK_API_KEY: apiKey, DSH_TELEMETRY_DISABLED: '1' },
  });
  let hostExited = false;
  let hostStartError = false;
  let hostErrorLines = 0;
  host.on('exit', () => { hostExited = true; });
  host.on('error', () => { hostStartError = true; });
  host.stderr.on('data', chunk => {
    hostErrorLines += String(chunk).split('\n').filter(line => /\berror\b/i.test(line)).length;
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const url = await new Promise<string>((resolveReady, reject) => {
      const timer = setTimeout(() => finish(new Error('Activated Web Host did not become ready')), 60_000);
      let output = '';
      const finish = (error?: Error, readyUrl?: string) => {
        clearTimeout(timer);
        host.stdout.removeListener('data', onData);
        host.removeListener('exit', onExit);
        host.removeListener('error', onError);
        if (error) reject(error);
        else resolveReady(readyUrl!);
      };
      const onData = (chunk: Buffer) => {
        output = `${output}${String(chunk)}`.slice(-4_096);
        const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{43})\r?\n/.exec(output);
        if (match) finish(undefined, match[1]);
      };
      const onExit = (code: number | null) => finish(new Error(`Activated Web Host exited before readiness: ${code}`));
      const onError = () => finish(new Error('Activated Web Host could not start'));
      host.stdout.on('data', onData);
      host.once('exit', onExit);
      host.once('error', onError);
    });
    host.stdout.resume();
    const exchange = await fetch(url, { redirect: 'manual' });
    assert.equal(exchange.status, 303, 'Activated Web Host did not accept its launch token');
    const ciWithoutSandbox = process.platform === 'linux' && process.env.CI === 'true';
    browser = await chromium.launch({ executablePath: browserBin, headless: true,
      chromiumSandbox: !ciWithoutSandbox,
      env: { PATH: process.env.PATH ?? '', HOME: root, LANG: process.env.LANG ?? 'C.UTF-8' } });
    const page = await browser.newPage({ locale: 'en-US' });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.name));
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    assert.equal(response?.status(), 200, 'Activated Web Host did not serve the UI');
    const continueButton = page.getByRole('button', { name: 'Continue' });
    await continueButton.waitFor({ timeout: 5_000 }).catch(() => {});
    if (await continueButton.isVisible()) await continueButton.click();
    await page.getByRole('button', { name: 'New Session' }).first().click();
    const chooseWorkspace = page.getByRole('textbox', { name: 'Choose workspace' });
    const editor = page.getByRole('textbox',
      { name: 'Describe what you want to build, / commands, @ files or sessions' });
    const readySurface = await Promise.any([
      chooseWorkspace.waitFor({ timeout: 30_000 }).then(() => 'choose-workspace' as const),
      editor.waitFor({ timeout: 30_000 }).then(() => 'editor' as const),
    ]);
    if (readySurface === 'choose-workspace') {
      await chooseWorkspace.click();
      const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' });
      await dialog.waitFor({ timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Edit path' }).click();
      const pathInput = dialog.getByRole('textbox', { name: 'Edit path' });
      await pathInput.fill(workspace);
      await pathInput.press('Enter');
      await dialog.getByRole('button', { name: 'Open', exact: true }).click();
    }
    try {
      await editor.waitFor({ timeout: 30_000 });
    } catch {
      const selectedRows = await page.locator('[data-row-key^="session:"][aria-selected="true"]').count();
      const visibleText = (await page.locator('body').innerText()).slice(0, 1_000);
      throw new Error(`Activated Web composer absent; selectedRows=${selectedRows}; ` +
        `pageErrors=${pageErrors.join(',') || 'none'}; visibleUI=${visibleText}`);
    }
    await editor.fill('Verify the activated Workbench Web profile.');
    await editor.press('Enter');
    await page.locator('[data-conversation-content]').getByText(answer, { exact: false })
      .first().waitFor({ timeout: 60_000 });
    const handoff = page.getByRole('button', { name: 'Copy Session ID for TUI' });
    await handoff.waitFor({ timeout: 30_000 });
    const title = await handoff.getAttribute('title');
    assert.ok(title, 'Activated Web plugin did not report its contract identity');
    assert.ok(title.includes(`Workbench ${workbenchIdentity.release.version}`));
    assert.ok(title.includes(workbenchIdentity.contractDigest));
    assert.ok(title.includes(workbenchIdentity.components.runtimeKit.source.commit));
    assert.ok(title.includes(`TUI ${workbenchIdentity.components.tui.package.version}`));
    assert.equal(pageErrors.length, 0, 'Activated Web UI reported JavaScript errors');
    assert.ok(mock.requests.length >= 1, 'Activated Web UI did not reach the authenticated mock');
    assert.equal(hostStartError, false, 'Activated Web Host reported a process startup error');
    assert.equal(hostExited, false, 'Activated Web Host exited during the browser turn');
    assert.equal(hostErrorLines, 0, 'Activated Web Host reported errors');
  } finally {
    const stopHost = async () => {
      if (!host.pid) return;
      try { process.kill(-host.pid, 'SIGTERM'); } catch { /* already exited */ }
      await new Promise<void>(resolveStopped => {
        if (host.exitCode !== null || host.signalCode !== null) { resolveStopped(); return; }
        const timer = setTimeout(() => { host.removeListener('exit', stopped); resolveStopped(); }, 5_000);
        const stopped = () => { clearTimeout(timer); resolveStopped(); };
        host.once('exit', stopped);
      });
      try { process.kill(-host.pid, 'SIGKILL'); } catch { /* process group exited */ }
    };
    const cleanup = await Promise.allSettled([
      browser?.close() ?? Promise.resolve(), stopHost(), mock.close(),
    ]);
    if (cleanup.some(result => result.status === 'rejected')) {
      throw new Error('Activated Web acceptance resource cleanup failed');
    }
  }
}

const apiKey = randomBytes(24).toString('hex');
try {
  await verifyActivatedWeb(apiKey);
  process.stdout.write(JSON.stringify({
    schema_version: 'dsh-workbench.combined-runtime-verification.v1',
    ok: true, profile: 'workbench', status: 'healthy', composition: 'passed', activatedWeb: 'passed',
  }) + '\n');
} catch (error) {
  process.stderr.write(`${publicBrowserFailure(error, [apiKey])}\n`);
  process.exitCode = 1;
}
