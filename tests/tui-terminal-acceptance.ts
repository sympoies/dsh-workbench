import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import headless from '@xterm/headless';
import * as pty from 'node-pty';
import type { WorkbenchContract } from '../src/contract-types.ts';
import { readEvents } from './session-events.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const { Terminal } = headless;
const contract = JSON.parse(readFileSync(join(repo, 'compatibility/workbench.json'), 'utf8')) as WorkbenchContract;
const installedHome = option('--installed-dsh-home');
const runtimeEnvFile = option('--runtime-env-file');
if (Boolean(installedHome) !== Boolean(runtimeEnvFile)) {
  throw new Error('Installed DSH home and runtime environment file must be provided together');
}
const runtimeEnvironment = runtimeEnvFile ? JSON.parse(readFileSync(runtimeEnvFile, 'utf8')) as NodeJS.ProcessEnv : {};
const profileName = installedHome ? 'workbench' : 'dsh-tui';
const scenarios = [
  { name: 'allow', decision: '\r', outcome: 'allowed-once', toolOutput: 'TUI_ALLOW_TOOL_OK',
    answer: 'TUI_ALLOW_FINISHED', error: false },
  { name: 'reject', decision: '\x1b', outcome: 'rejected', toolOutput: 'TUI_REJECT_TOOL_OUTPUT',
    answer: 'TUI_REJECT_FINISHED', error: true },
] as const;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || !isAbsolute(value)) throw new Error(`Required absolute path after ${name}`);
  return resolve(value);
}

function binaryOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Required option: ${name} <absolute path>`);
  return value;
}

function command(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 32_000_000 });
  assert.equal(result.error, undefined, `${binary} could not start`);
  assert.equal(result.status, 0, `${binary} failed with exit ${result.status}:\n${result.stdout?.slice(-4_000)}\n${result.stderr?.slice(-4_000)}`);
  return result.stdout.trim();
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sessionLogs(root: string): string[] {
  const found: string[] = [];
  const pending = [root];
  while (pending.length) {
    const path = pending.pop()!;
    for (const item of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, item.name);
      if (item.isDirectory()) pending.push(child);
      else if (item.isFile() && item.name === 'session.v4.jsonl.zstd') found.push(child);
    }
  }
  return found;
}

async function waitForTurn(root: string, previous: ReadonlySet<string>): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const added = sessionLogs(root).filter(path => !previous.has(path));
    if (added.length > 1) throw new Error('TUI created more than one session for one approval scenario');
    if (added.length === 1) {
      const events = readEvents(added[0]);
      if (events.some(event => event.type === 'turn/end')) return added[0];
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('TUI did not persist a completed approval turn');
}

async function waitForTurnCount(path: string, count: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (readEvents(path).filter(event => event.type === 'turn/end').length >= count) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`TUI did not complete turn ${count}`);
}

async function waitForTitle(path: string, title: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (readEvents(path).some(event => event.type === 'session/title' && event.data?.title === title)) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('TUI did not persist the long-session title');
}

function startTerminal(binary: string, fixture: string, baseURL: string, apiKey: string, appArgs: string[] = []): {
  write: (data: string) => void;
  stop: () => Promise<void>;
  readonly exitCode: number | null;
  waitFor: (marker: string | RegExp) => Promise<void>;
  waitForAfter: (first: string, second: string) => Promise<void>;
} {
  const home = join(fixture, 'home');
  const child = pty.spawn(binary, ['--profile', profileName, ...appArgs], {
    name: 'xterm-256color', cols: 80, rows: 24,
    cwd: join(fixture, 'workspace'),
    env: {
      PATH: `${dirname(binary)}:${process.env.PATH ?? ''}`,
      HOME: home,
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(fixture, 'agents'),
      XDG_CONFIG_HOME: join(fixture, 'config'),
      ...runtimeEnvironment,
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_BASE_URL: `${baseURL}/v1`,
      DEEPSEEK_API_KEY: apiKey,
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
    },
  });
  const screen = new Terminal({ cols: 80, rows: 24, scrollback: 1_000, allowProposedApi: true });
  const listeners = new Set<() => void>();
  const exitListeners = new Set<() => void>();
  let exitCode: number | null = null;
  let exitSignal: number | undefined;
  let startupOutput = '';
  child.onData(chunk => {
    startupOutput = (startupOutput + chunk).slice(-8_192);
    screen.write(chunk, () => { for (const listener of listeners) listener(); });
  });
  child.onExit(result => {
    exitCode = result.exitCode;
    exitSignal = result.signal;
    for (const listener of exitListeners) listener();
  });
  const startupFailure = () => {
    const categories = [
      ['pty', /inappropriate ioctl|not a tty|tcgetattr|could not open.*pty/i],
      ['module-load', /cannot find module|ERR_MODULE_NOT_FOUND|module not found/i],
      ['profile-load', /profile.*(not found|invalid|failed)|failed.*profile/i],
      ['missing-command', /command not found|no such file or directory/i],
    ] as const;
    const category = categories.find(([, pattern]) => pattern.test(startupOutput))?.[0] ?? 'unclassified';
    let diagnostic = startupOutput
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replaceAll(apiKey, '[redacted key]')
      .replaceAll(baseURL, '[mock endpoint]')
      .replaceAll(fixture, '[fixture]')
      .replaceAll(home, '[home]')
      .replace(/[\x00-\x1f\x7f]/g, ' ');
    if (installedHome) diagnostic = diagnostic.replaceAll(installedHome, '[installed home]');
    diagnostic = diagnostic.slice(-1_500);
    return `TUI exited with ${exitCode ?? exitSignal}; startup category ${category}; output: ${diagnostic}`;
  };
  const visibleScreen = () => Array.from({ length: screen.rows }, (_, row) =>
    screen.buffer.active.getLine(screen.buffer.active.viewportY + row)?.translateToString(true) ?? '').join('\n');
  const diagnosticScreen = () => {
    let value = visibleScreen().replaceAll(apiKey, '[redacted key]')
      .replaceAll(baseURL, '[mock endpoint]').replaceAll(fixture, '[fixture]');
    if (installedHome) value = value.replaceAll(installedHome, '[installed home]');
    return value.trim().slice(-1_500);
  };
  return {
    write: data => child.write(data),
    get exitCode() { return exitCode; },
    stop: async () => {
      if (exitCode !== null) return;
      const waitForExit = (milliseconds: number) => new Promise<boolean>(resolveWait => {
        const timer = setTimeout(() => { exitListeners.delete(onExit); resolveWait(false); }, milliseconds);
        const onExit = () => { clearTimeout(timer); exitListeners.delete(onExit); resolveWait(true); };
        exitListeners.add(onExit);
        if (exitCode !== null) onExit();
      });
      child.write('\x03\x03');
      if (await waitForExit(5_000)) return;
      if (exitCode !== null) return;
      child.kill('SIGTERM');
      if (await waitForExit(5_000)) return;
      if (exitCode !== null) return;
      child.kill('SIGKILL');
      if (!await waitForExit(5_000)) throw new Error('TUI PTY did not stop within 15 seconds');
    },
    waitForAfter: (first, second) => new Promise<void>((resolveWait, reject) => {
      if (exitCode !== null) {
        reject(new Error(`TUI exited before ${second}: ${startupFailure()}`));
        return;
      }
      const timer = setTimeout(() => finish(new Error(`TUI did not show ${second} after ${first}`)), 60_000);
      const onExit = () => finish(new Error(`TUI exited before ${second}: ${startupFailure()}`));
      const check = () => {
        const frame = visibleScreen();
        if (frame.lastIndexOf(second) > frame.lastIndexOf(first) && frame.includes(first)) finish();
      };
      function finish(error?: Error) {
        clearTimeout(timer);
        listeners.delete(check);
        exitListeners.delete(onExit);
        if (error) reject(error); else resolveWait();
      }
      listeners.add(check);
      exitListeners.add(onExit);
      check();
    }),
    waitFor: marker => new Promise<void>((resolveWait, reject) => {
      if (exitCode !== null) {
        reject(new Error(`TUI exited before ${marker}: ${startupFailure()}`));
        return;
      }
      const timer = setTimeout(() => finish(new Error(`TUI did not show ${marker}; screen: ${diagnosticScreen()}`)), 60_000);
      const onExit = () => finish(new Error(`TUI exited before ${marker}: ${startupFailure()}`));
      const check = () => {
        const frame = visibleScreen();
        if (typeof marker === 'string' ? frame.includes(marker) : marker.test(frame)) finish();
      };
      function finish(error?: Error) {
        clearTimeout(timer);
        listeners.delete(check);
        exitListeners.delete(onExit);
        if (error) reject(error); else resolveWait();
      }
      listeners.add(check);
      exitListeners.add(onExit);
      check();
    }),
  };
}

async function runSessionScenario(binary: string, fixture: string): Promise<void> {
  const apiKey = randomBytes(24).toString('hex');
  const answer = 'TUI_SESSION_ANSWER';
  const mock = await startMockLlmServer({ sequence: ['success'], repeatLast: true, apiKey, successText: answer });
  const logRoot = join(fixture, 'home', 'sessions');
  const previous = new Set(sessionLogs(logRoot));
  // Two visible transcript rows per turn exceed the pinned TUI's 120-row
  // initial rendering cap, exercising its long-session projection on resume.
  const prompts = Array.from({ length: 72 }, (_, index) => `TUI_SESSION_TURN_${index + 1}`);
  let terminal: ReturnType<typeof startTerminal> | undefined;
  try {
    terminal = startTerminal(binary, fixture, mock.baseURL, apiKey);
    await terminal.waitFor('Explore the uncharted!');
    terminal.write(`${prompts[0]}\r`);
    const logPath = await waitForTurn(logRoot, previous);
    for (let index = 1; index < prompts.length; index += 1) {
      terminal.write(`${prompts[index]}\r`);
      await waitForTurnCount(logPath, index + 1);
    }
    await waitForTitle(logPath, answer);
    await terminal.stop();
    assert.equal(terminal.exitCode, 0, 'TUI did not exit cleanly before resume');
    const sessionId = basename(dirname(logPath));
    terminal = startTerminal(binary, fixture, mock.baseURL, apiKey, ['--resume', sessionId]);
    await terminal.waitFor(answer);
    terminal.write('TUI_SESSION_RESUMED_TURN\r');
    await waitForTurnCount(logPath, prompts.length + 1);
    await terminal.waitForAfter('TUI_SESSION_RESUMED_TURN', answer);
    terminal.write('/resume\r');
    await terminal.waitFor(new RegExp(`\\b${previous.size + 1} total\\b`));
    await terminal.waitFor(new RegExp(`Sessions[\\s\\S]*${answer}`));
    await terminal.stop();
    assert.equal(terminal.exitCode, 0, 'TUI did not exit cleanly after resume');
    assert.deepEqual(sessionLogs(logRoot).filter(path => !previous.has(path)), [logPath],
      'Exact-ID resume created another session');
    const events = readEvents(logPath, { strict: true });
    const ended = events.filter(event => event.type === 'turn/end');
    assert.equal(ended.length, prompts.length + 1,
      `Unexpected turns: ${JSON.stringify(ended.map(event => event.data?.turn))}; mock requests: ${mock.requests.length}`);
    const userText = JSON.stringify(events.filter(event => event.type === 'user/message'));
    for (const prompt of [...prompts, 'TUI_SESSION_RESUMED_TURN']) assert.ok(userText.includes(prompt));
    const answerMessages = events.filter(event => event.type === 'assistant/message'
      && JSON.stringify(event.data?.message).includes(answer));
    assert.equal(answerMessages.length, prompts.length + 1);
    assert.equal(events.filter(event => event.type === 'session/title').at(-1)?.data?.title, answer);
    assert.ok(mock.requests.filter(request => request.behavior === 'success').length >= prompts.length + 1);
  } finally {
    const cleanup = await Promise.allSettled([terminal?.stop(), mock.close()]);
    if (cleanup.some(result => result.status === 'rejected')) throw new Error('TUI session cleanup failed');
  }
}

async function runRenameScenario(binary: string, fixture: string): Promise<void> {
  const apiKey = randomBytes(24).toString('hex');
  const answer = 'TUI_RENAME_ANSWER';
  const renamed = 'WB_MANUAL_RENAME';
  const mock = await startMockLlmServer({ sequence: ['success'], repeatLast: true, apiKey, successText: answer });
  const logRoot = join(fixture, 'home', 'sessions');
  const previous = new Set(sessionLogs(logRoot));
  let terminal: ReturnType<typeof startTerminal> | undefined;
  try {
    terminal = startTerminal(binary, fixture, mock.baseURL, apiKey);
    await terminal.waitFor('Explore the uncharted!');
    terminal.write('TUI_RENAME_FIRST\r');
    const logPath = await waitForTurn(logRoot, previous);
    terminal.write(`/rename ${renamed}\r`);
    await waitForTitle(logPath, renamed);
    await terminal.stop();
    assert.equal(terminal.exitCode, 0, 'TUI did not exit cleanly after rename');
    const sessionId = basename(dirname(logPath));
    terminal = startTerminal(binary, fixture, mock.baseURL, apiKey, ['--resume', sessionId]);
    await terminal.waitFor(answer);
    terminal.write('TUI_RENAME_RESUMED\r');
    await waitForTurnCount(logPath, 2);
    await terminal.waitForAfter('TUI_RENAME_RESUMED', answer);
    await terminal.stop();
    assert.equal(terminal.exitCode, 0, 'TUI did not exit cleanly after renamed resume');
    const offlineTitle = 'WB_OFFLINE_RENAME';
    const offlineWriter = pathToFileURL(join(fixture, 'home', 'profiles', profileName, 'node_modules',
      contract.components.tui.package.name, 'lib/types/dsh-adapter/compat/sessionLog.js')).href;
    command(process.execPath, ['--input-type=module', '-e',
      `import { appendSessionTitle } from ${JSON.stringify(offlineWriter)};
       if (appendSessionTitle(process.argv[1], process.argv[2]) !== 'appended') process.exit(1);`,
      sessionId, offlineTitle], join(fixture, 'workspace'), {
      ...process.env, HOME: join(fixture, 'home'), DSH_HOME: join(fixture, 'home'),
    });
    terminal = startTerminal(binary, fixture, mock.baseURL, apiKey, ['--resume', sessionId]);
    await terminal.waitFor(answer);
    terminal.write('TUI_OFFLINE_RENAME_RESUMED\r');
    await waitForTurnCount(logPath, 3);
    await terminal.waitForAfter('TUI_OFFLINE_RENAME_RESUMED', answer);
    await terminal.stop();
    assert.equal(terminal.exitCode, 0, 'TUI did not exit cleanly after offline rename');
    assert.deepEqual(sessionLogs(logRoot).filter(path => !previous.has(path)), [logPath]);
    const events = readEvents(logPath, { strict: true });
    assert.equal(events.filter(event => event.type === 'turn/end').length, 3);
    assert.deepEqual(events.filter(event => event.type === 'session/title').at(-1)?.data,
      { title: offlineTitle, messageSeqs: [], source: { kind: 'user' } });
    assert.ok(events.some(event => event.type === 'session/title'
      && event.data?.title === renamed
      && (event.data?.source as { kind?: string } | undefined)?.kind === 'user'));
  } finally {
    const cleanup = await Promise.allSettled([terminal?.stop(), mock.close()]);
    if (cleanup.some(result => result.status === 'rejected')) throw new Error('TUI rename cleanup failed');
  }
}

async function runScenario(binary: string, fixture: string, scenario: typeof scenarios[number]): Promise<void> {
  const apiKey = randomBytes(24).toString('hex');
  const marker = join(fixture, 'workspace', `.tui-${scenario.name}-executed`);
  const toolCommand = installedHome ? `printf ${scenario.toolOutput}`
    : `touch ${quote(marker)} && printf ${scenario.toolOutput}`;
  const mock = await startMockLlmServer({ sequence: ['tool_call_success', 'success'], repeatLast: true,
    apiKey, successText: scenario.answer, toolName: 'bash',
    toolArguments: JSON.stringify({ command: toolCommand,
      description: `Print ${scenario.toolOutput}`, sandbox_permissions: 'danger-full-access',
      justification: 'Verify TUI approval in a disposable workspace' }) });
  const logRoot = join(fixture, 'home', 'sessions');
  mkdirSync(logRoot, { recursive: true });
  const previous = new Set(sessionLogs(logRoot));
  let terminal: ReturnType<typeof startTerminal> | undefined;
  try {
    terminal = startTerminal(binary, fixture, mock.baseURL, apiKey);
    await terminal.waitFor('Explore the uncharted!');
    terminal.write(`Run the Bash command printf ${scenario.toolOutput} and report its output.\r`);
    await terminal.waitFor('Awaiting approval · bash');
    terminal.write(scenario.decision);
    const logPath = await waitForTurn(logRoot, previous);
    await terminal.stop();
    assert.equal(terminal.exitCode, 0, 'TUI did not exit cleanly');
    const events = readEvents(logPath, { strict: true });
    const ended = events.find(event => event.type === 'turn/end');
    assert.equal((ended?.data?.reason as { kind?: string } | undefined)?.kind, 'completed');
    const finalMessage = events.filter(event => event.type === 'assistant/message').at(-1)?.data?.message as
      { content?: Array<{ type?: string; text?: string }> } | undefined;
    assert.ok(finalMessage?.content?.some(block => block.type === 'text' && block.text === scenario.answer),
      'TUI did not persist the expected final answer');
    const decided = events.find(event => event.type === 'approval/decided');
    const result = events.find(event => event.type === 'tool/result');
    assert.equal(decided?.data?.outcome, scenario.outcome);
    assert.equal((result?.data?.message as { isError?: boolean } | undefined)?.isError, scenario.error);
    const content = JSON.stringify((result?.data?.message as { content?: unknown } | undefined)?.content);
    if (scenario.error) {
      assert.ok(content.includes('the user rejected escalating this command'));
      assert.ok(!content.includes(scenario.toolOutput));
      if (!installedHome) assert.equal(existsSync(marker), false, 'Rejected Bash command still executed');
    } else {
      assert.ok(content.includes(scenario.toolOutput));
      if (!installedHome) assert.equal(existsSync(marker), true, 'Allowed Bash command did not execute');
    }
    assert.ok(mock.requests.some(request => request.behavior === 'tool_call_success'));
  } catch (error) {
    const behaviors = mock.requests.map(request => request.behavior).join(',') || 'none';
    throw new Error(`${error instanceof Error ? error.message : String(error)}; mock behaviors: ${behaviors}`);
  } finally {
    const cleanup = await Promise.allSettled([terminal?.stop(), mock.close()]);
    if (cleanup.some(result => result.status === 'rejected')) throw new Error('TUI acceptance cleanup failed');
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('This real TTY acceptance requires Linux or macOS');
  }
  const dsh = binaryOption('--dsh-bin');
  assert.equal(command(dsh, ['--version'], repo, { ...process.env, ...runtimeEnvironment }),
    contract.components.dsh.package.version);
  assert.equal(command('pnpm', ['--version'], repo), contract.runtime.pnpm);
  command('zstdcat', ['--version'], repo);
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-workbench-tui-'));
  try {
    const home = join(fixture, 'home');
    if (installedHome) {
      assert.ok(existsSync(join(installedHome, '.workbench-terminal-acceptance')),
        'Installed DSH home is not marked as a disposable terminal acceptance fixture');
      symlinkSync(installedHome, home, 'dir');
    }
    const profile = join(home, 'profiles', profileName);
    for (const path of [join(fixture, 'agents'), join(fixture, 'workspace')]) {
      mkdirSync(path, { recursive: true });
    }
    if (installedHome) command('git', ['clone', '--local', '--no-hardlinks', '--quiet', repo,
      join(fixture, 'workspace')], repo);
    if (!installedHome) {
      mkdirSync(profile, { recursive: true });
      writeFileSync(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-dsh-tui', private: true,
        dependencies: { [contract.components.tui.package.name]: contract.components.tui.package.version },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', contract.components.tui.package.name] } },
      }, null, 2));
      writeFileSync(join(profile, 'cordis.yml'), '[]\n');
      writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
      writeFileSync(join(profile, 'pnpm-workspace.yaml'), command(process.execPath,
        [join(repo, 'scripts/tui-compat.mjs')], repo) + '\n');
      copyFileSync(join(repo, 'compatibility/tui-profile/pnpm-lock.yaml'), join(profile, 'pnpm-lock.yaml'));
      mkdirSync(join(profile, 'patches'));
      copyFileSync(join(repo, contract.components.tui.compatibilityPatch!.path), join(profile, 'patches/tui-rename.patch'));
      const userConfig = join(fixture, 'user.npmrc');
      const globalConfig = join(fixture, 'global.npmrc');
      writeFileSync(userConfig, '');
      writeFileSync(globalConfig, '');
      command('pnpm', ['install', '--frozen-lockfile', '--strict-peer-dependencies', '--ignore-scripts'], profile, {
        PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: join(fixture, 'config'),
        npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
      });
    }
    const profileManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      name: string; dsh: { profile: { bundles: string[] } };
    };
    assert.equal(profileManifest.name, `dsh-profile-${profileName}`);
    assert.ok(profileManifest.dsh.profile.bundles.includes(contract.components.tui.package.name));
    const installedTui = JSON.parse(readFileSync(join(profile, 'node_modules',
      contract.components.tui.package.name, 'package.json'), 'utf8')) as { version: string };
    assert.equal(installedTui.version, contract.components.tui.package.version);
    for (const scenario of scenarios) await runScenario(dsh, fixture, scenario);
    await runSessionScenario(dsh, fixture);
    await runRenameScenario(dsh, fixture);
    console.log(JSON.stringify({ result: 'pass', scenarios: scenarios.map(scenario => scenario.name),
      approvals: true, toolResults: true, exactIdResume: true, manualRenameResume: true,
      offlineRenameResume: true, realTty: true }));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

await main().catch(error => {
  console.error(JSON.stringify({ result: 'fail', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
