import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import type { WorkbenchContract } from '../src/contract-types.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(join(repo, 'compatibility/workbench.json'), 'utf8')) as WorkbenchContract;
const answer = 'WORKBENCH_SMOKE_OK';
const prompts = ['FIRST_FIXTURE_PROMPT', 'SECOND_FIXTURE_PROMPT'] as const;
const errorPrompt = 'ERROR_FIXTURE_PROMPT';
const editorName = 'Describe what you want to build, / commands, @ files or sessions';

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
  let errorLines = 0;
  child.stderr.on('data', chunk => {
    errorLines += String(chunk).split('\n').filter(line => /\berror\b/i.test(line)).length;
  });
  try {
    const url = await new Promise<string>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('DSH Web Host startup timed out')), 60_000);
      child.stdout.on('data', chunk => {
        output = `${output}${String(chunk)}`.slice(-4096);
        const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/.exec(output);
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
    return { child, url, errorCount: () => errorLines };
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

async function openPage(browser: Browser, url: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ locale: 'en-US' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.name));
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  assert.equal(response?.status(), 200, 'DSH Web Host did not serve the UI');
  const continueButton = page.getByRole('button', { name: 'Continue' });
  await continueButton.waitFor({ timeout: 5_000 }).catch(() => {});
  if (await continueButton.isVisible()) await continueButton.click();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  return { page, errors };
}

function launchBrowser(executablePath: string, home: string): Promise<Browser> {
  return chromium.launch({ executablePath, headless: true,
    env: { PATH: process.env.PATH ?? '', HOME: home, LANG: process.env.LANG ?? 'C.UTF-8' },
    chromiumSandbox: true });
}

async function copiedSessionId(page: Page): Promise<string> {
  const button = page.getByRole('button', { name: 'Copy Session ID for TUI' });
  await button.waitFor({ timeout: 30_000 });
  await button.click();
  const id = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(/^session-[0-9a-f-]{36}$/.test(id), 'copied ID is not a DSH session ID');
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
    let opened = await openPage(browser, host.url);
    const firstPage = opened.page;
    const firstErrors = opened.errors;
    await firstPage.getByRole('button', { name: 'New Session' }).first().click();
    const chooseWorkspace = firstPage.getByRole('button', { name: 'Choose workspace' });
    if (await chooseWorkspace.count()) {
      await chooseWorkspace.click();
      await firstPage.getByRole('button', { name: 'Edit path' }).click();
      const pathInput = firstPage.getByRole('textbox', { name: 'Edit path' });
      await pathInput.fill(workspace);
      await pathInput.press('Enter');
      await firstPage.getByRole('button', { name: 'Open', exact: true }).click();
    }
    const editor = firstPage.getByRole('textbox', { name: editorName });
    await editor.waitFor({ timeout: 30_000 });
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
    pageErrors += firstErrors.length;
    hostErrors += host.errorCount();
    await browser.close();
    browser = undefined;
    await stopHost(host.child);
    host = undefined;

    host = await startHost(dsh, home, agents, workspace, mock.baseURL, apiKey);
    browser = await launchBrowser(browserBin, home);
    opened = await openPage(browser, host.url);
    await checkHistory(opened.page, firstId, prompts[0], prompts[1]);
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
    let errorOpened = await openPage(browser, host.url);
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
    errorOpened = await openPage(browser, host.url);
    await checkFailedHistory(errorOpened.page, errorId);
    pageErrors += errorOpened.errors.length;
    hostErrors += host.errorCount();
    assert.equal(pageErrors, 0, 'browser reported JavaScript errors');
    assert.equal(hostErrors, 0, 'DSH Web Host reported errors');
    assert.equal(mock.requests[0]?.behavior, 'invalid_request');
    console.log(JSON.stringify({ result: 'pass', sessions: 3, toolApproval: true,
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
