#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApprovalMockLlmServer } from '../tests/approval-mock.ts';
import { chromium } from 'playwright-core';
import { publicBrowserFailure } from '../src/browser-diagnostic.ts';
import { readEvents } from '../tests/session-events.ts';
import { workbenchIdentity } from '../web/src/identity.ts';

const [kitPackage, dshSource, dshHome, runtimeRoot, nilsBin, browserBin, installedDshCli] = process.argv.slice(2);
if (installedDshCli !== undefined) {
  let valid = false;
  try {
    const expectedPackage = workbenchIdentity.components.dsh.package;
    const packageRoot = join(dshHome, 'profiles', 'workbench', 'node_modules', expectedPackage.name);
    const expectedCli = join(packageRoot, 'lib', 'bin.js');
    if (isAbsolute(dshHome) && isAbsolute(installedDshCli)
      && resolve(installedDshCli) === resolve(expectedCli) && statSync(expectedCli).isFile()) {
      const installedPackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
      valid = installedPackage.name === expectedPackage.name
        && installedPackage.version === expectedPackage.version;
    }
  } catch { /* invalid target */ }
  if (!valid) {
    process.stderr.write('WORKBENCH_INSTALLED_CLI_INVALID: provide the exact profile CLI entry at the contract version\n');
    process.exit(64);
  }
}
if ([kitPackage, dshSource, dshHome, runtimeRoot, nilsBin, browserBin]
  .some(value => !value || !isAbsolute(value)) || ![8, 9].includes(process.argv.length)) {
  process.stderr.write('Usage: node scripts/verify-combined-runtime.ts <packed-kit-dir> <dsh-root> <dsh-home> <runtime-root> <nils-bin-dir> <browser-bin> [absolute-installed-dsh-cli]\n');
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
const dshCli = installedDshCli ?? join(dshSource, 'apps', 'cli', 'lib', 'bin.js');
for (const directory of [runtimeRoot, root, workspace, configHome, stateHome, docsHome,
  join(configHome, 'agent-hook'), join(root, 'codex'), join(root, 'claude'),
  join(root, 'private-skills')]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
const sourceRepo = fileURLToPath(new URL('..', import.meta.url));
const cloned = spawnSync('git', ['clone', '--local', '--no-hardlinks', '--quiet', sourceRepo, workspace],
  { encoding: 'utf8', timeout: 60_000 });
assert.equal(cloned.status, 0, 'Could not create a disposable Git workspace');
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
// This disposable installation owns its DSH sessions. An outer agent's managed
// principal belongs to another checkout and must not claim these test sessions.
const environment = Object.fromEntries(Object.entries({ ...process.env, ...runtimeEnvironment })
  .filter(([name]) => !name.toUpperCase().startsWith('AGENT_SESSION_')));
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
const unmanagedHomeFile = join(dshHome, 'AGENTS.md');
const unmanagedHomeBytes = Buffer.from('# Existing DSH home instructions\n');
writeFileSync(unmanagedHomeFile, unmanagedHomeBytes, { mode: 0o600 });
const unmanagedPreview = spawnSync(process.execPath,
  [launcher, '--runtime-root', runtimeRoot, '--', process.execPath, cli,
    'setup', '--profile', 'workbench', '--package', kitPackage, '--format', 'json'],
  { env: environment, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
assert.equal(unmanagedPreview.status, 65, 'Unmanaged DSH home instructions were not refused');
const unmanagedDenial = JSON.parse(unmanagedPreview.stdout);
assert.equal(unmanagedDenial.error?.code, 'agent-home-unmanaged');
assert.deepEqual(readFileSync(unmanagedHomeFile), unmanagedHomeBytes,
  'Runtime-kit changed an unmanaged DSH home instructions file');
unlinkSync(unmanagedHomeFile);
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
assert.match(composition.stdout, /@sympoies\/dsh-workbench-web/);

const webScenarios = [
  { name: 'allow', answer: 'ACTIVATED_WEB_ALLOW_FINISHED', output: 'ACTIVATED_WEB_ALLOW_TOOL_OK',
    outcome: 'allowed-once', error: false, button: 'Allow once' },
  { name: 'reject', answer: 'ACTIVATED_WEB_REJECT_FINISHED', output: 'ACTIVATED_WEB_REJECT_TOOL_OK',
    outcome: 'rejected', error: true, button: 'Reject' },
] as const;

function sessionLog(id: string): string {
  const pending = [join(dshHome, 'sessions')];
  const matches: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd'
        && basename(dirname(path)) === id) matches.push(path);
    }
  }
  assert.equal(matches.length, 1, 'Activated Web session has no unique Session V4 archive');
  return matches[0];
}

async function verifyActivatedWeb(apiKey: string, scenario: typeof webScenarios[number]): Promise<void> {
  const marker = join(root, `activated-web-${scenario.name}-executed`);
  if (existsSync(marker)) unlinkSync(marker);
  const command = `touch '${marker.replaceAll("'", "'\\''")}' && printf ${scenario.output}`;
  const mock = await startApprovalMockLlmServer({ sequence: ['tool_call_success', 'success'], repeatLast: true,
    successText: scenario.answer, apiKey, toolName: 'bash',
    toolArguments: JSON.stringify({ command, description: `Print ${scenario.output}`,
      sandbox_permissions: 'danger-full-access',
      justification: 'Verify Web approval in a disposable workspace' }) });
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
  let sessionId: string | undefined;
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
    if (await continueButton.isVisible()) {
      await continueButton.click();
      await page.getByRole('dialog', { name: 'Internal Testing Notice' })
        .waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {
          throw new Error('WORKBENCH_WEB_WELCOME_ACK_FAILED: acknowledgement did not persist');
        });
    }
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
      await dialog.waitFor({ timeout: 30_000 });
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
    await editor.fill(`Run the Bash command printf ${scenario.output} and report its output.`);
    await editor.press('Enter');
    const approval = page.locator('[data-approval-key]');
    await approval.waitFor({ timeout: 60_000 }).catch(() => {
      throw new Error(`WORKBENCH_WEB_APPROVAL_NOT_REQUESTED: ${scenario.name}`);
    });
    assert.ok((await approval.innerText()).includes(scenario.output),
      'Activated Web approval did not display the selected Bash command');
    await approval.getByRole('button', { name: scenario.button }).click();
    await page.locator('[data-conversation-content]').getByText(scenario.answer, { exact: false })
      .first().waitFor({ timeout: 60_000 });
    const row = await page.locator('[data-row-key^="session:"][aria-selected="true"]')
      .getAttribute('data-row-key');
    assert.match(row ?? '', /^session:(?:session-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    sessionId = row!.slice('session:'.length);
    const handoff = page.getByRole('button', { name: 'Copy Session ID for TUI' });
    await handoff.waitFor({ timeout: 30_000 });
    const title = await handoff.getAttribute('title');
    assert.ok(title, 'Activated Web plugin did not report its contract identity');
    assert.ok(title.includes(`Workbench ${workbenchIdentity.release.version}`));
    assert.ok(title.includes(workbenchIdentity.graphDigest));
    assert.ok(title.includes(workbenchIdentity.components.runtimeKit.source.commit));
    assert.ok(title.includes(`TUI ${workbenchIdentity.components.tui.package.version}`));
    assert.equal(pageErrors.length, 0, 'Activated Web UI reported JavaScript errors');
    assert.ok(mock.requests.some(request => request.behavior === 'tool_call_success'),
      'Activated Web UI did not receive the Bash tool call');
    assert.equal(hostStartError, false, 'Activated Web Host reported a process startup error');
    assert.equal(hostExited, false, 'Activated Web Host exited during the browser turn');
    assert.equal(hostErrorLines, 0, 'Activated Web Host reported errors');
    const deadline = Date.now() + 60_000;
    while (!readEvents(sessionLog(sessionId)).some(event => event.type === 'turn/end')) {
      assert.ok(Date.now() < deadline, 'Activated Web did not durably finish its approval turn');
      assert.equal(hostExited, false, 'Activated Web exited before durable turn completion');
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
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
  assert.ok(sessionId, 'Activated Web approval did not create a session');
  const events = readEvents(sessionLog(sessionId), { strict: true });
  const ended = events.find(event => event.type === 'turn/end');
  assert.equal((ended?.data?.reason as { kind?: string } | undefined)?.kind, 'completed',
    `WORKBENCH_WEB_TURN_NOT_COMPLETED: ${scenario.name}`);
  assert.equal(events.find(event => event.type === 'approval/decided')?.data?.outcome,
    scenario.outcome);
  const result = events.find(event => event.type === 'tool/result')?.data?.message as
    { isError?: boolean; content?: unknown } | undefined;
  assert.equal(result?.isError, scenario.error, 'Activated Web archived the wrong tool result');
  const content = JSON.stringify(result?.content);
  if (scenario.error) {
    assert.equal(existsSync(marker), false, 'Rejected activated Web command still executed');
    assert.ok(content.includes('the user rejected escalating this command'));
    assert.ok(!content.includes(scenario.output));
  } else {
    assert.equal(existsSync(marker), true, 'Allowed activated Web command did not execute');
    assert.ok(content.includes(scenario.output));
  }
}

const apiKey = randomBytes(24).toString('hex');
try {
  for (const scenario of webScenarios) await verifyActivatedWeb(apiKey, scenario);
  process.stdout.write(JSON.stringify({
    schema_version: 'dsh-workbench.combined-runtime-verification.v1',
    ok: true, profile: 'workbench', status: 'healthy', composition: 'passed', activatedWeb: 'passed',
  }) + '\n');
} catch (error) {
  process.stderr.write(`${publicBrowserFailure(error, [apiKey])}\n`);
  process.exitCode = 1;
}
