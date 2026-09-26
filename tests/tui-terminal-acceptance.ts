import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import headless from '@xterm/headless';
import type { WorkbenchContract } from '../src/contract-types.ts';
import { readEvents } from './session-events.ts';
import { stopTerminal } from './terminal-process.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const { Terminal } = headless;
const contract = JSON.parse(readFileSync(join(repo, 'compatibility/workbench.json'), 'utf8')) as WorkbenchContract;
const scenarios = [
  { name: 'allow', decision: '\r', outcome: 'allowed-once', toolOutput: 'TUI_ALLOW_TOOL_OK',
    answer: 'TUI_ALLOW_FINISHED', error: false },
  { name: 'reject', decision: '\x1b', outcome: 'rejected', toolOutput: 'TUI_REJECT_TOOL_OUTPUT',
    answer: 'TUI_REJECT_FINISHED', error: true },
] as const;

function binaryOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith('--')) throw new Error(`Required option: ${name} <absolute path>`);
  return resolve(value);
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
  child: ChildProcess;
  waitFor: (marker: string | RegExp) => Promise<void>;
  waitForAfter: (first: string, second: string) => Promise<void>;
} {
  const home = join(fixture, 'home');
  const scriptArgs = process.platform === 'darwin'
    ? ['-q', '/dev/null', binary, '--profile', 'dsh-tui', ...appArgs]
    : ['-q', '-e', '-c', `${quote(binary)} --profile dsh-tui ${appArgs.map(quote).join(' ')}`, '/dev/null'];
  const child = spawn('script', scriptArgs, {
    cwd: join(fixture, 'workspace'),
    detached: true,
    env: {
      PATH: `${dirname(binary)}:${process.env.PATH ?? ''}`,
      HOME: home,
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(fixture, 'agents'),
      XDG_CONFIG_HOME: join(fixture, 'config'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_BASE_URL: `${baseURL}/v1`,
      DEEPSEEK_API_KEY: apiKey,
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const screen = new Terminal({ cols: 80, rows: 24, scrollback: 1_000, allowProposedApi: true });
  const listeners = new Set<() => void>();
  let startupOutput = '';
  child.stdout.on('data', chunk => {
    startupOutput = (startupOutput + String(chunk)).slice(-8_192);
    screen.write(chunk, () => { for (const listener of listeners) listener(); });
  });
  child.stderr.on('data', chunk => { startupOutput = (startupOutput + String(chunk)).slice(-8_192); });
  const startupFailure = () => {
    const categories = [
      ['pty', /inappropriate ioctl|not a tty|tcgetattr|could not open.*pty/i],
      ['script-usage', /usage:\s*script|illegal option.*script/i],
      ['module-load', /cannot find module|ERR_MODULE_NOT_FOUND|module not found/i],
      ['profile-load', /profile.*(not found|invalid|failed)|failed.*profile/i],
      ['missing-command', /command not found|no such file or directory/i],
    ] as const;
    const category = categories.find(([, pattern]) => pattern.test(startupOutput))?.[0] ?? 'unclassified';
    return `TUI exited with ${child.exitCode ?? child.signalCode}; startup category ${category}`;
  };
  const visibleScreen = () => Array.from({ length: screen.rows }, (_, row) =>
    screen.buffer.active.getLine(screen.buffer.active.viewportY + row)?.translateToString(true) ?? '').join('\n');
  return {
    child,
    waitForAfter: (first, second) => new Promise<void>((resolveWait, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
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
        child.off('exit', onExit);
        if (error) reject(error); else resolveWait();
      }
      listeners.add(check);
      child.once('exit', onExit);
      check();
    }),
    waitFor: marker => new Promise<void>((resolveWait, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(new Error(`TUI exited before ${marker}: ${startupFailure()}`));
        return;
      }
      const timer = setTimeout(() => finish(new Error(`TUI did not show ${marker}`)), 60_000);
      const onExit = () => finish(new Error(`TUI exited before ${marker}: ${startupFailure()}`));
      const check = () => {
        const frame = visibleScreen();
        if (typeof marker === 'string' ? frame.includes(marker) : marker.test(frame)) finish();
      };
      function finish(error?: Error) {
        clearTimeout(timer);
        listeners.delete(check);
        child.off('exit', onExit);
        if (error) reject(error); else resolveWait();
      }
      listeners.add(check);
      child.once('exit', onExit);
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
    terminal.child.stdin?.write(`${prompts[0]}\r`);
    const logPath = await waitForTurn(logRoot, previous);
    for (let index = 1; index < prompts.length; index += 1) {
      terminal.child.stdin?.write(`${prompts[index]}\r`);
      await waitForTurnCount(logPath, index + 1);
    }
    await waitForTitle(logPath, answer);
    await stopTerminal(terminal.child);
    assert.equal(terminal.child.exitCode, 0, 'TUI did not exit cleanly before resume');
    const sessionId = basename(dirname(logPath));
    terminal = startTerminal(binary, fixture, mock.baseURL, apiKey, ['--resume', sessionId]);
    await terminal.waitFor(answer);
    terminal.child.stdin?.write('TUI_SESSION_RESUMED_TURN\r');
    await waitForTurnCount(logPath, prompts.length + 1);
    await terminal.waitForAfter('TUI_SESSION_RESUMED_TURN', answer);
    terminal.child.stdin?.write('/resume\r');
    await terminal.waitFor(new RegExp(`\\b${previous.size + 1} total\\b`));
    await terminal.waitFor(new RegExp(`Sessions[\\s\\S]*${answer}`));
    await stopTerminal(terminal.child);
    assert.equal(terminal.child.exitCode, 0, 'TUI did not exit cleanly after resume');
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
    const cleanup = await Promise.allSettled([stopTerminal(terminal?.child), mock.close()]);
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
    terminal.child.stdin?.write('TUI_RENAME_FIRST\r');
    const logPath = await waitForTurn(logRoot, previous);
    terminal.child.stdin?.write(`/rename ${renamed}\r`);
    await waitForTitle(logPath, renamed);
    await stopTerminal(terminal.child);
    assert.equal(terminal.child.exitCode, 0, 'TUI did not exit cleanly after rename');
    const sessionId = basename(dirname(logPath));
    terminal = startTerminal(binary, fixture, mock.baseURL, apiKey, ['--resume', sessionId]);
    await terminal.waitFor(answer);
    terminal.child.stdin?.write('TUI_RENAME_RESUMED\r');
    await waitForTurnCount(logPath, 2);
    await terminal.waitForAfter('TUI_RENAME_RESUMED', answer);
    await stopTerminal(terminal.child);
    assert.equal(terminal.child.exitCode, 0, 'TUI did not exit cleanly after renamed resume');
    const offlineTitle = 'WB_OFFLINE_RENAME';
    const offlineWriter = pathToFileURL(join(fixture, 'home', 'profiles', 'dsh-tui', 'node_modules',
      contract.components.tui.package.name, 'lib/types/dsh-adapter/compat/sessionLog.js')).href;
    command(process.execPath, ['--input-type=module', '-e',
      `import { appendSessionTitle } from ${JSON.stringify(offlineWriter)};
       if (appendSessionTitle(process.argv[1], process.argv[2]) !== 'appended') process.exit(1);`,
      sessionId, offlineTitle], join(fixture, 'workspace'), {
      ...process.env, HOME: join(fixture, 'home'), DSH_HOME: join(fixture, 'home'),
    });
    terminal = startTerminal(binary, fixture, mock.baseURL, apiKey, ['--resume', sessionId]);
    await terminal.waitFor(answer);
    terminal.child.stdin?.write('TUI_OFFLINE_RENAME_RESUMED\r');
    await waitForTurnCount(logPath, 3);
    await terminal.waitForAfter('TUI_OFFLINE_RENAME_RESUMED', answer);
    await stopTerminal(terminal.child);
    assert.equal(terminal.child.exitCode, 0, 'TUI did not exit cleanly after offline rename');
    assert.deepEqual(sessionLogs(logRoot).filter(path => !previous.has(path)), [logPath]);
    const events = readEvents(logPath, { strict: true });
    assert.equal(events.filter(event => event.type === 'turn/end').length, 3);
    assert.deepEqual(events.filter(event => event.type === 'session/title').at(-1)?.data,
      { title: offlineTitle, messageSeqs: [], source: { kind: 'user' } });
    assert.ok(events.some(event => event.type === 'session/title'
      && event.data?.title === renamed
      && (event.data?.source as { kind?: string } | undefined)?.kind === 'user'));
  } finally {
    const cleanup = await Promise.allSettled([stopTerminal(terminal?.child), mock.close()]);
    if (cleanup.some(result => result.status === 'rejected')) throw new Error('TUI rename cleanup failed');
  }
}

async function runScenario(binary: string, fixture: string, scenario: typeof scenarios[number]): Promise<void> {
  const apiKey = randomBytes(24).toString('hex');
  const marker = join(fixture, 'workspace', `.tui-${scenario.name}-executed`);
  const mock = await startMockLlmServer({ sequence: ['tool_call_success', 'success'], repeatLast: true,
    apiKey, successText: scenario.answer, toolName: 'bash',
    toolArguments: JSON.stringify({ command: `touch ${quote(marker)} && printf ${scenario.toolOutput}`,
      description: `Print ${scenario.toolOutput}`, sandbox_permissions: 'danger-full-access',
      justification: 'Verify TUI approval in a disposable workspace' }) });
  const logRoot = join(fixture, 'home', 'sessions');
  mkdirSync(logRoot, { recursive: true });
  const previous = new Set(sessionLogs(logRoot));
  let terminal: ReturnType<typeof startTerminal> | undefined;
  try {
    terminal = startTerminal(binary, fixture, mock.baseURL, apiKey);
    await terminal.waitFor('Explore the uncharted!');
    terminal.child.stdin?.write(`Run the Bash command printf ${scenario.toolOutput} and report its output.\r`);
    await terminal.waitFor('Awaiting approval · bash');
    terminal.child.stdin?.write(scenario.decision);
    const logPath = await waitForTurn(logRoot, previous);
    await stopTerminal(terminal.child);
    assert.equal(terminal.child.exitCode, 0, 'TUI did not exit cleanly');
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
      assert.equal(existsSync(marker), false, 'Rejected Bash command still executed');
    } else {
      assert.ok(content.includes(scenario.toolOutput));
      assert.equal(existsSync(marker), true, 'Allowed Bash command did not execute');
    }
    assert.ok(mock.requests.some(request => request.behavior === 'tool_call_success'));
  } finally {
    const cleanup = await Promise.allSettled([stopTerminal(terminal?.child), mock.close()]);
    if (cleanup.some(result => result.status === 'rejected')) throw new Error('TUI acceptance cleanup failed');
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('This real TTY acceptance requires Linux or macOS script');
  }
  const dsh = binaryOption('--dsh-bin');
  assert.equal(command(dsh, ['--version'], repo), contract.components.dsh.package.version);
  assert.equal(command('pnpm', ['--version'], repo), contract.runtime.pnpm);
  if (process.platform === 'linux') command('script', ['--version'], repo);
  command('zstdcat', ['--version'], repo);
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-workbench-tui-'));
  try {
    const home = join(fixture, 'home');
    const profile = join(home, 'profiles', 'dsh-tui');
    for (const path of [profile, join(fixture, 'agents'), join(fixture, 'workspace')]) {
      mkdirSync(path, { recursive: true });
    }
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
