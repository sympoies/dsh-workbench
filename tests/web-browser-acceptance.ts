import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import headless from '@xterm/headless';
import * as pty from 'node-pty';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import type { WorkbenchContract } from '../src/contract-types.ts';
import { workbenchIdentity } from '../web/src/identity.ts';
import { readEvents } from './session-events.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(join(repo, 'compatibility/workbench.json'), 'utf8')) as WorkbenchContract;
const answer = 'WORKBENCH_SMOKE_OK';
const prompts = ['FIRST_FIXTURE_PROMPT', 'SECOND_FIXTURE_PROMPT'] as const;
const errorPrompt = 'ERROR_FIXTURE_PROMPT';
const editorName = 'Describe what you want to build, / commands, @ files or sessions';
const tuiPrompt = 'TUI_TO_WEB_RENAMED_PROMPT';
const tuiAnswer = 'TUI_TO_WEB_RENAMED_ANSWER';
const tuiTitle = 'TUI_TO_WEB_MANUAL_TITLE';
const continuationPrompt = 'WEB_TO_TUI_CONTINUATION_PROMPT';
const continuationAnswer = 'WEB_TO_TUI_CONTINUATION_ANSWER';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith('--')) {
    throw new Error(`Required option: ${name} <absolute executable path>`);
  }
  return resolve(value);
}

function command(binary: string, args: string[], cwd: string,
  timeout = 300_000, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout });
  assert.equal(result.error, undefined, `${binary} did not start`);
  assert.equal(result.status, 0, `${binary} failed with exit ${result.status}:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function sessionLogs(root: string): string[] {
  const found: string[] = [];
  const pending = [root];
  while (pending.length) {
    const path = pending.pop()!;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') found.push(child);
    }
  }
  return found;
}

function sessionLog(root: string, id: string): string {
  const matches = sessionLogs(root).filter(path => basename(dirname(path)) === id);
  assert.equal(matches.length, 1, 'Session has no unique Session V4 archive');
  return matches[0];
}

function logDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

type TuiProcess = ReturnType<typeof startTui>;

async function waitForTui(tui: TuiProcess, condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    if (tui.exitCode !== null) {
      throw new Error(`TUI exited before ${label}: ${tui.exitCode}`);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`TUI did not reach ${label}`);
}

function visibleScreen(screen: InstanceType<typeof headless.Terminal>): string {
  return Array.from({ length: screen.rows }, (_, row) =>
    screen.buffer.active.getLine(screen.buffer.active.viewportY + row)?.translateToString(true) ?? '').join('\n');
}

function startTui(dsh: string, fixture: string, home: string, agents: string, workspace: string,
  baseURL: string, apiKey: string, args: string[] = []) {
  const child = pty.spawn(dsh, ['--profile', 'dsh-tui', ...args], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: workspace,
    env: { PATH: `${dirname(dsh)}:${process.env.PATH ?? ''}`, HOME: home, DSH_HOME: home,
      DSH_AGENTS_HOME: agents, XDG_CONFIG_HOME: join(fixture, 'config'),
      LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
      DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_BASE_URL: `${baseURL}/v1`, DEEPSEEK_API_KEY: apiKey },
  });
  const screen = new headless.Terminal({ cols: 80, rows: 24, scrollback: 1_000, allowProposedApi: true });
  child.onData(chunk => { screen.write(chunk); });
  let exitCode: number | null = null;
  const exitListeners = new Set<(code: number) => void>();
  child.onExit(result => {
    exitCode = result.signal ? 128 + result.signal : result.exitCode;
    for (const listener of exitListeners) listener(exitCode);
  });
  const waitForExit = (milliseconds: number) => new Promise<number>((resolveExit, reject) => {
    if (exitCode !== null) { resolveExit(exitCode); return; }
    const timer = setTimeout(() => {
      exitListeners.delete(onExit);
      reject(new Error('TUI did not exit within the expected time'));
    }, milliseconds);
    const onExit = (code: number) => { clearTimeout(timer); exitListeners.delete(onExit); resolveExit(code); };
    exitListeners.add(onExit);
  });
  return {
    screen,
    get exitCode() { return exitCode; },
    write: (data: string) => child.write(data),
    waitForExit,
    stop: async () => {
      if (exitCode !== null) return;
      child.write('\x03\x03');
      try { await waitForExit(5_000); return; } catch { /* escalate below */ }
      if (exitCode !== null) return;
      child.kill('SIGTERM');
      try { await waitForExit(5_000); return; } catch { /* escalate below */ }
      if (exitCode !== null) return;
      child.kill('SIGKILL');
      await waitForExit(5_000);
    },
  };
}

async function seedTuiRenamedSession(dsh: string, fixture: string, home: string,
  agents: string, workspace: string, userConfig: string, globalConfig: string): Promise<string> {
  const profile = join(home, 'profiles', 'dsh-tui');
  mkdirSync(join(profile, 'patches'), { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-dsh-tui', private: true,
    dependencies: { [contract.components.tui.package.name]: contract.components.tui.package.version },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', contract.components.tui.package.name] } },
  }, null, 2));
  writeFileSync(join(profile, 'cordis.yml'), '[]\n');
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(profile, 'pnpm-workspace.yaml'),
    command(process.execPath, [join(repo, 'scripts/tui-compat.mjs')], repo) + '\n');
  copyFileSync(join(repo, 'compatibility/tui-profile/pnpm-lock.yaml'), join(profile, 'pnpm-lock.yaml'));
  copyFileSync(join(repo, contract.components.tui.compatibilityPatch!.path), join(profile, 'patches/tui-rename.patch'));
  command('pnpm', ['install', '--frozen-lockfile', '--strict-peer-dependencies', '--ignore-scripts'], profile,
    300_000, { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(fixture, 'config'),
      npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig });
  const apiKey = randomBytes(24).toString('hex');
  const mock = await startMockLlmServer({ sequence: ['success'], repeatLast: true,
    apiKey, successText: tuiAnswer });
  const logRoot = join(home, 'sessions');
  mkdirSync(logRoot, { recursive: true });
  const previous = new Set(sessionLogs(logRoot));
  const tui = startTui(dsh, fixture, home, agents, workspace, mock.baseURL, apiKey);
  try {
    await waitForTui(tui, () => visibleScreen(tui.screen).includes('Explore the uncharted!'), 'startup');
    tui.write(`${tuiPrompt}\r`);
    let logPath: string | undefined;
    await waitForTui(tui, () => {
      const added = sessionLogs(logRoot).filter(path => !previous.has(path));
      if (added.length !== 1) return false;
      logPath = added[0];
      return readEvents(logPath).some(event => event.type === 'turn/end');
    }, 'settled first turn');
    tui.write(`/rename ${tuiTitle}\r`);
    await waitForTui(tui, () => readEvents(logPath!).some(event =>
      event.type === 'session/title' && event.data?.title === tuiTitle), 'manual title');
    await tui.stop();
    assert.equal(tui.exitCode, 0, 'TUI did not exit cleanly before Web handoff');
    const events = readEvents(logPath!, { strict: true });
    assert.deepEqual(events.filter(event => event.type === 'session/title').at(-1)?.data,
      { title: tuiTitle, messageSeqs: [], source: { kind: 'user' } });
    return basename(dirname(logPath!));
  } finally {
    const cleanup = await Promise.allSettled([tui.stop(), mock.close()]);
    if (cleanup.some(result => result.status === 'rejected')) throw new Error('TUI seed cleanup failed');
  }
}

async function continueWebSessionInTui(dsh: string, fixture: string, home: string, agents: string,
  workspace: string, id: string): Promise<void> {
  const logRoot = join(home, 'sessions');
  const logPath = sessionLog(logRoot, id);
  const turnsBefore = readEvents(logPath, { strict: true }).filter(event => event.type === 'turn/end').length;
  const previous = new Set(sessionLogs(logRoot));
  const apiKey = randomBytes(24).toString('hex');
  const mock = await startMockLlmServer({ sequence: ['success'], repeatLast: true,
    apiKey, successText: continuationAnswer });
  const tui = startTui(dsh, fixture, home, agents, workspace, mock.baseURL, apiKey,
    ['--resume', id]);
  try {
    await waitForTui(tui, () => visibleScreen(tui.screen).includes(answer), 'resumed Web history');
    tui.write(`${continuationPrompt}\r`);
    await waitForTui(tui, () => readEvents(logPath).filter(event => event.type === 'turn/end').length
      === turnsBefore + 1, 'completed TUI continuation');
    await tui.stop();
    assert.equal(tui.exitCode, 0, 'TUI did not exit cleanly after Web handoff');
    assert.deepEqual(sessionLogs(logRoot).filter(path => !previous.has(path)), [],
      'Exact-ID TUI continuation created another session');
    const events = readEvents(logPath, { strict: true });
    assert.ok(JSON.stringify(events.filter(event => event.type === 'user/message')).includes(continuationPrompt));
    assert.ok(JSON.stringify(events.filter(event => event.type === 'assistant/message')).includes(continuationAnswer));
  } finally {
    const cleanup = await Promise.allSettled([tui.stop(), mock.close()]);
    if (cleanup.some(result => result.status === 'rejected')) throw new Error('TUI continuation cleanup failed');
  }
}

async function checkWebWriterContention(dsh: string, fixture: string, home: string, agents: string,
  workspace: string, id: string, baseURL: string, apiKey: string): Promise<void> {
  const logPath = sessionLog(join(home, 'sessions'), id);
  const before = logDigest(logPath);
  const tui = startTui(dsh, fixture, home, agents, workspace, baseURL, apiKey,
    ['--resume', id]);
  try {
    const exit = await tui.waitForExit(20_000);
    assert.notEqual(exit, 0, 'TUI did not refuse the Web-held writer with an error');
    assert.equal(logDigest(logPath), before, 'Rejected TUI access changed the Web-held archive');
  } finally {
    await tui.stop();
  }
}

async function startHost(binary: string, home: string, agents: string, workspace: string,
  baseURL: string, apiKey: string) {
  const child = spawn(binary, ['--profile', 'web', '--host', '127.0.0.1', '--no-open', '--port', '0'], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'C.UTF-8',
      HOME: home,
      DSH_HOME: home,
      DSH_AGENTS_HOME: agents,
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_BASE_URL: `${baseURL}/v1`,
      DEEPSEEK_API_KEY: apiKey,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  let errorLines = 0;
  child.stderr.on('data', chunk => {
    const text = String(chunk);
    errorLines += text.split('\n').filter(line => /\berror\b/i.test(line)).length;
    stderr = `${stderr}${text}`.slice(-4_096);
  });
  try {
    const url = await new Promise<string>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('DSH Web Host startup timed out')), 60_000);
      child.stdout.on('data', chunk => {
        output = `${output}${String(chunk)}`.slice(-4096);
        const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{43})\r?\n/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolveReady(match[1]);
        }
      });
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`DSH Web Host exited before readiness: ${code}`));
      });
    });
    const diagnostic = () => stderr
      .replaceAll(apiKey, '[redacted key]')
      .replaceAll(baseURL, '[mock endpoint]')
      .replaceAll(home, '[home]')
      .replaceAll(agents, '[agents]')
      .replaceAll(workspace, '[workspace]')
      .replace(/([?&]token=)[^\s"']+/gi, '$1[redacted]')
      .slice(-1_500);
    return { child, url, errorCount: () => errorLines, diagnostic };
  } catch (error) {
    await stopHost(child);
    throw error;
  }
}

async function stopHost(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolveStopped => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10_000);
    child.once('exit', () => { clearTimeout(timer); resolveStopped(); });
    child.kill('SIGTERM');
  });
}

async function openPage(browser: Browser, host: Awaited<ReturnType<typeof startHost>>): Promise<{ page: Page; errors: string[] }> {
  const exchange = await fetch(host.url, { redirect: 'manual' });
  assert.equal(exchange.status, 303, `DSH Web Host rejected its complete launch token: HTTP ${exchange.status}`);
  assert.equal(exchange.headers.get('location'), '/', 'DSH Web Host did not redirect after launch token exchange');
  assert.ok(exchange.headers.has('set-cookie'), 'DSH Web Host did not issue a browser cookie');
  const page = await browser.newPage({ locale: 'en-US' });
  const errors: string[] = [];
  const responses: string[] = [];
  page.on('pageerror', error => errors.push(error.name));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === new URL(host.url).origin) {
      responses.push(`${response.status()} ${url.pathname}${url.searchParams.has('token') ? '?token' : ''}`);
    }
  });
  let response;
  try {
    response = await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (error) {
    const cookieCount = (await page.context().cookies(new URL(host.url).origin))
      .filter(cookie => cookie.name.startsWith('dsh-auth-')).length;
    throw new Error(`Web navigation failed; responses: ${responses.join(', ') || 'none'}; auth cookies: ${cookieCount}; host diagnostic: ${host.diagnostic()}; browser: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert.equal(response?.status(), 200, 'DSH Web Host did not serve the UI');
  const continueButton = page.getByRole('button', { name: 'Continue' });
  await continueButton.waitFor({ timeout: 5_000 }).catch(() => {});
  if (await continueButton.isVisible()) await continueButton.click();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  return { page, errors };
}

function launchBrowser(executablePath: string, home: string): Promise<Browser> {
  const ciWithoutSandbox = process.argv.includes('--ci-no-browser-sandbox');
  if (ciWithoutSandbox && (process.env.CI !== 'true' || process.platform !== 'linux')) {
    throw new Error('The browser sandbox exception is limited to Linux CI');
  }
  return chromium.launch({ executablePath, headless: true,
    env: { PATH: process.env.PATH ?? '', HOME: home, LANG: process.env.LANG ?? 'C.UTF-8' },
    chromiumSandbox: !ciWithoutSandbox });
}

async function copiedSessionId(page: Page): Promise<string> {
  const button = page.getByRole('button', { name: 'Copy Session ID for TUI' });
  await button.waitFor({ timeout: 30_000 });
  const title = await button.getAttribute('title');
  assert.ok(title, 'Web plugin did not report its contract identity');
  assert.ok(title.includes(workbenchIdentity.contractDigest), 'Web plugin did not report the exact contract digest');
  assert.ok(title.includes(`Workbench ${contract.release.version}`));
  assert.ok(title.includes(`(${contract.status})`));
  assert.ok(title.includes(`DSH ${contract.components.dsh.package.version}`));
  assert.ok(title.includes(contract.components.runtimeKit.source.commit));
  assert.ok(title.includes(`TUI ${contract.components.tui.package.version}`));
  await button.click();
  const id = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(/^(?:session-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id),
    'copied ID is not a DSH session ID');
  return id;
}

async function startNewSession(page: Page, phase: string, completedIds: readonly string[]): Promise<Locator> {
  const selected = page.locator('[data-row-key^="session:"][aria-selected="true"]');
  const previous = await selected.getAttribute('data-row-key');
  const alreadyBlank = previous !== null
    && !completedIds.some(id => previous === `session:${id}`)
    && await selected.getByText('New Session', { exact: true }).count() > 0
    && await page.locator('[data-conversation-content] [data-chat-flow-kind="user"]').count() === 0;
  await page.getByRole('button', { name: 'New Session' }).first().click();
  if (!alreadyBlank) {
    try {
      await page.waitForFunction(previousKey => {
        const row = document.querySelector('[data-row-key^="session:"][aria-selected="true"]');
        return row !== null && row.getAttribute('data-row-key') !== previousKey;
      }, previous, { timeout: 30_000 });
    } catch {
      throw new Error(`${phase}: New Session did not replace the selected session`);
    }
  }
  const editor = page.getByRole('textbox', { name: editorName });
  await editor.waitFor({ timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  while ((await editor.textContent())?.trim() !== '' && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  assert.equal((await editor.textContent())?.trim(), '', 'new session composer retained the previous prompt');
  return editor;
}

async function waitForMockRequests(mock: Awaited<ReturnType<typeof startMockLlmServer>>,
  count: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (mock.requests.length < count && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  assert.ok(mock.requests.length >= count, `expected ${count} mock requests before the next session`);
}

async function checkHistory(page: Page, id: string, own: string, other: string): Promise<void> {
  const row = page.locator(`[data-row-key="session:${id}"]`);
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  assert.ok(await copiedSessionId(page) === id, 'header ID does not match selected sidebar session');
  const conversation = page.locator('[data-conversation-content]');
  await conversation.getByText(own, { exact: false }).first().waitFor({ timeout: 30_000 });
  const body = await conversation.innerText();
  assert.ok(body.includes(own), 'session lost its prompt');
  assert.ok(!body.includes(other), 'session shows another session prompt');
  assert.ok(body.includes(answer), 'session lost its mock answer');
}

async function checkTuiHandoff(page: Page, id: string): Promise<void> {
  const row = page.locator(`[data-row-key="session:${id}"]`);
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  assert.equal(await copiedSessionId(page), id, 'Web opened another TUI session ID');
  await row.getByText(tuiTitle, { exact: true }).waitFor({ timeout: 30_000 });
  const conversation = page.locator('[data-conversation-content]');
  await conversation.getByText(tuiPrompt, { exact: false }).first().waitFor({ timeout: 30_000 });
  const body = await conversation.innerText();
  assert.ok(body.includes(tuiPrompt), 'Web lost the TUI prompt');
  assert.ok(body.includes(tuiAnswer), 'Web lost the TUI answer');
}

async function openToolDetails(page: Page) {
  const conversation = page.locator('[data-conversation-content]');
  const turn = conversation.locator('[data-turn-process="1"]');
  await turn.waitFor({ timeout: 30_000 });
  assert.equal(await turn.getAttribute('data-turn-process-tool-calls'), '1');
  if (await turn.getAttribute('aria-expanded') === 'false') await turn.click();
  const group = conversation.locator('[data-process-activity="commands"]');
  await group.waitFor({ timeout: 30_000 });
  if (await group.getAttribute('aria-expanded') === 'false') await group.click();
  const call = conversation.locator('[data-chat-flow-kind="tool-call"]');
  await call.waitFor({ state: 'visible', timeout: 30_000 });
  await call.click();
  return call;
}

async function checkToolResult(page: Page): Promise<void> {
  const call = await openToolDetails(page);
  await call.getByText('TOOL_OK', { exact: true }).waitFor({ timeout: 30_000 });
}

async function checkRejectedTool(page: Page): Promise<void> {
  const call = await openToolDetails(page);
  await call.getByText('Failed', { exact: true }).waitFor({ timeout: 30_000 });
  assert.ok((await call.innerText()).includes('the user rejected escalating this command'));
  assert.equal(await call.getByText('TOOL_OK', { exact: true }).count(), 0,
    'a rejected command displayed a success output');
}

async function checkFailedHistory(page: Page, id: string): Promise<void> {
  const row = page.locator(`[data-row-key="session:${id}"]`);
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  assert.ok(await copiedSessionId(page) === id, 'failed session opened under another ID');
  const content = page.locator('[data-conversation-content]');
  await content.getByText('This turn failed', { exact: false }).first().waitFor({ timeout: 30_000 });
  const body = await content.innerText();
  assert.ok(body.includes(errorPrompt));
  assert.ok(body.includes('mock invalid request'));
  assert.ok(!body.includes(prompts[0]) && !body.includes(prompts[1]));
}

async function main(): Promise<void> {
  const dsh = option('--dsh-bin');
  const browserBin = option('--browser-bin');
  assert.equal(command(dsh, ['--version'], repo), contract.components.dsh.package.version);
  assert.equal(command('pnpm', ['--version'], repo), contract.runtime.pnpm);
  command('pnpm', ['web:build'], repo);

  const fixture = mkdtempSync(join(tmpdir(), 'dsh-workbench-web-'));
  const home = join(fixture, 'home');
  const agents = join(fixture, 'agents');
  const workspace = join(fixture, 'workspace');
  const profile = join(home, 'profiles', 'web');
  for (const directory of [home, agents, workspace, profile]) mkdirSync(directory, { recursive: true });
  let mock: Awaited<ReturnType<typeof startMockLlmServer>> | undefined;
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  let browser: Browser | undefined;
  let pageErrors = 0;
  let hostErrors = 0;
  try {
    const packed = command('pnpm', ['pack', '--pack-destination', fixture], join(repo, 'web'));
    const archive = resolve(fixture, packed.split('\n').at(-1)!);
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-workbench-web-browser-acceptance', private: true, type: 'module',
      dependencies: { '@sympoies/dsh-workbench-web': `file:${relative(profile, archive)}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2));
    writeFileSync(join(profile, 'cordis.patch.yml'),
      "- insert:\n    - id: dsh-workbench-web\n      name: '@sympoies/dsh-workbench-web'\n");
    const userConfig = join(fixture, 'user.npmrc');
    const globalConfig = join(fixture, 'global.npmrc');
    writeFileSync(userConfig, '');
    writeFileSync(globalConfig, '');
    command('pnpm', ['install', '--strict-peer-dependencies', '--ignore-scripts',
      '--reporter', 'append-only'], profile, 300_000, {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'C.UTF-8',
      HOME: home,
      XDG_CONFIG_HOME: join(fixture, 'config'),
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
    });

    const tuiSessionId = await seedTuiRenamedSession(dsh, fixture, home, agents,
      workspace, userConfig, globalConfig);

    const apiKey = randomBytes(24).toString('hex');
    mock = await startMockLlmServer({ sequence: ['tool_call_success', 'success', 'success', 'tool_call_success', 'success'],
      repeatLast: true, successText: answer, apiKey, toolName: 'bash',
      toolArguments: JSON.stringify({ command: 'printf TOOL_OK', description: 'Print TOOL_OK',
        sandbox_permissions: 'danger-full-access', justification: 'Verify the approval UI in a disposable workspace' }) });
    const unauthorized = await fetch(`${mock.baseURL}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(unauthorized.status, 401, 'mock endpoint accepted an unauthenticated request');
    host = await startHost(dsh, home, agents, workspace, mock.baseURL, apiKey);
    browser = await launchBrowser(browserBin, home);
    let opened = await openPage(browser, host);
    const firstPage = opened.page;
    const firstErrors = opened.errors;
    await checkTuiHandoff(firstPage, tuiSessionId);
    const editor = await startNewSession(firstPage, 'first', [tuiSessionId]);
    await editor.fill(prompts[0]);
    await editor.press('Enter');
    const approval = firstPage.locator('[data-approval-key]');
    await approval.waitFor({ timeout: 30_000 });
    const approvalText = await approval.innerText();
    assert.ok(approvalText.includes('Waiting for approval'));
    assert.ok(approvalText.includes('printf TOOL_OK'));
    assert.ok(await approval.getByRole('button', { name: 'Reject' }).isVisible());
    assert.ok((await firstPage.locator('[data-turn-process="1"]').innerText()).includes('Deep diving'),
      'the turn appeared settled while approval was pending');
    await approval.getByRole('button', { name: 'Allow once' }).click();
    await firstPage.getByText('Worked', { exact: true }).first().waitFor({ timeout: 30_000 });
    const firstId = await copiedSessionId(firstPage);
    await checkToolResult(firstPage);

    // First-turn title generation runs independently of the tool continuation.
    // Let it consume its scripted success before the next tool scenario begins.
    await waitForMockRequests(mock, 3);

    const secondEditor = await startNewSession(firstPage, 'second', [firstId]);
    await secondEditor.fill(prompts[1]);
    await secondEditor.press('Enter');
    await approval.waitFor({ timeout: 30_000 });
    await approval.getByRole('button', { name: 'Reject' }).click();
    await approval.waitFor({ state: 'hidden', timeout: 30_000 });
    await firstPage.getByText('Worked', { exact: true }).first().waitFor({ timeout: 30_000 });
    const secondId = await copiedSessionId(firstPage);
    assert.ok(firstId !== secondId, 'two new sessions share an ID');
    await checkHistory(firstPage, firstId, prompts[0], prompts[1]);
    await checkHistory(firstPage, secondId, prompts[1], prompts[0]);
    await checkRejectedTool(firstPage);
    await checkHistory(firstPage, firstId, prompts[0], prompts[1]);
    await checkWebWriterContention(dsh, fixture, home, agents, workspace, firstId, mock.baseURL, apiKey);
    pageErrors += firstErrors.length;
    hostErrors += host.errorCount();
    await browser.close();
    browser = undefined;
    await stopHost(host.child);
    host = undefined;

    await continueWebSessionInTui(dsh, fixture, home, agents, workspace, firstId);

    host = await startHost(dsh, home, agents, workspace, mock.baseURL, apiKey);
    browser = await launchBrowser(browserBin, home);
    opened = await openPage(browser, host);
    await checkTuiHandoff(opened.page, tuiSessionId);
    await checkHistory(opened.page, firstId, prompts[0], prompts[1]);
    const continued = await opened.page.locator('[data-conversation-content]').innerText();
    assert.ok(continued.includes(continuationPrompt), 'Web lost the TUI continuation prompt');
    assert.ok(continued.includes(continuationAnswer), 'Web lost the TUI continuation answer');
    await checkToolResult(opened.page);
    await checkHistory(opened.page, secondId, prompts[1], prompts[0]);
    await checkRejectedTool(opened.page);
    pageErrors += opened.errors.length;
    hostErrors += host.errorCount();
    assert.equal(pageErrors, 0, 'browser reported JavaScript errors');
    assert.equal(hostErrors, 0, 'DSH Web Host reported errors');
    assert.ok(mock.requests.length >= 2, 'the mock server received fewer than two requests');
    assert.equal(mock.requests.filter(request => request.behavior === 'tool_call_success').length, 2);
    const interactionRequests = mock.requests.length;
    await browser.close();
    browser = undefined;
    await stopHost(host.child);
    host = undefined;
    await mock.close();

    mock = await startMockLlmServer({ sequence: ['invalid_request'], repeatLast: true, apiKey });
    host = await startHost(dsh, home, agents, workspace, mock.baseURL, apiKey);
    browser = await launchBrowser(browserBin, home);
    let errorOpened = await openPage(browser, host);
    const errorPage = errorOpened.page;
    const errorEditor = await startNewSession(errorPage, 'error', [firstId, secondId]);
    await errorEditor.fill(errorPrompt);
    await errorEditor.press('Enter');
    await errorPage.locator('[data-conversation-content]')
      .getByText('This turn failed', { exact: false }).first().waitFor({ timeout: 30_000 });
    const errorId = await copiedSessionId(errorPage);
    await checkFailedHistory(errorPage, errorId);
    pageErrors += errorOpened.errors.length;
    hostErrors += host.errorCount();
    await browser.close();
    browser = undefined;
    await stopHost(host.child);
    host = undefined;

    host = await startHost(dsh, home, agents, workspace, mock.baseURL, apiKey);
    browser = await launchBrowser(browserBin, home);
    errorOpened = await openPage(browser, host);
    await checkFailedHistory(errorOpened.page, errorId);
    pageErrors += errorOpened.errors.length;
    hostErrors += host.errorCount();
    assert.equal(pageErrors, 0, 'browser reported JavaScript errors');
    assert.equal(hostErrors, 0, 'DSH Web Host reported errors');
    assert.equal(mock.requests[0]?.behavior, 'invalid_request');
    console.log(JSON.stringify({ result: 'pass', sessions: 4, tuiToWebTitle: true,
      webToTuiContinuation: true, writerContention: true, toolApproval: true,
      toolRejection: true, runningTurn: true, errorResume: true,
      toolResultsAfterRestart: true, restartResume: true,
      interactionRequests, errorRequests: mock.requests.length, pageErrors, hostErrors }));
  } finally {
    const cleanup = await Promise.allSettled([
      browser?.close() ?? Promise.resolve(),
      stopHost(host?.child),
      mock?.close() ?? Promise.resolve(),
    ]);
    rmSync(fixture, { recursive: true, force: true });
    if (cleanup.some(result => result.status === 'rejected')) {
      throw new Error('Browser acceptance resource cleanup failed');
    }
  }
}

await main().catch(error => {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ result: 'fail', error: name,
    message: message.replace(/([?&]token=)[^\s"']+/gi, '$1[redacted]').slice(0, 1500) }));
  process.exitCode = 1;
});
