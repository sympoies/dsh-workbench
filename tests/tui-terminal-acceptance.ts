import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import type { WorkbenchContract } from '../src/contract-types.ts';
import { stopTerminal } from './terminal-process.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
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
  assert.equal(result.status, 0, `${binary} failed with exit ${result.status}`);
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

type Event = { type: string; data?: Record<string, unknown> };

function readEvents(path: string): Event[] {
  const result = spawnSync('zstdcat', [path], { encoding: 'utf8', timeout: 5_000, maxBuffer: 32_000_000 });
  return result.stdout?.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as Event]; } catch { return []; }
  }) ?? [];
}

async function waitForTurn(root: string, previous: ReadonlySet<string>): Promise<{ path: string; events: Event[] }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const added = sessionLogs(root).filter(path => !previous.has(path));
    if (added.length > 1) throw new Error('TUI created more than one session for one approval scenario');
    if (added.length === 1) {
      const events = readEvents(added[0]);
      if (events.some(event => event.type === 'turn/end')) return { path: added[0], events };
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('TUI did not persist a completed approval turn');
}

function startTerminal(binary: string, fixture: string, baseURL: string, apiKey: string): {
  child: ChildProcess;
  waitFor: (marker: string) => Promise<void>;
} {
  const home = join(fixture, 'home');
  const child = spawn('script', ['-q', '-e', '-c', `${quote(binary)} --profile dsh-tui`, '/dev/null'], {
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
  let output = '';
  const listeners = new Set<() => void>();
  child.stdout.on('data', chunk => {
    output = `${output}${String(chunk)}`.slice(-131_072);
    for (const listener of listeners) listener();
  });
  return {
    child,
    waitFor: marker => new Promise<void>((resolveWait, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(new Error('TUI exited before the expected terminal state'));
        return;
      }
      const timer = setTimeout(() => finish(new Error(`TUI did not show ${marker}`)), 60_000);
      const onExit = () => finish(new Error('TUI exited before the expected terminal state'));
      const check = () => { if (output.includes(marker)) finish(); };
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

async function runScenario(binary: string, fixture: string, scenario: typeof scenarios[number]): Promise<void> {
  const apiKey = randomBytes(24).toString('hex');
  const mock = await startMockLlmServer({ sequence: ['tool_call_success', 'success'], repeatLast: true,
    apiKey, successText: scenario.answer, toolName: 'bash',
    toolArguments: JSON.stringify({ command: `printf ${scenario.toolOutput}`,
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
    const { events } = await waitForTurn(logRoot, previous);
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
    } else {
      assert.ok(content.includes(scenario.toolOutput));
    }
    assert.ok(mock.requests.some(request => request.behavior === 'tool_call_success'));
    await stopTerminal(terminal.child);
    assert.equal(terminal.child.exitCode, 0, 'TUI did not exit cleanly');
  } finally {
    const cleanup = await Promise.allSettled([stopTerminal(terminal?.child), mock.close()]);
    if (cleanup.some(result => result.status === 'rejected')) throw new Error('TUI acceptance cleanup failed');
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'linux') throw new Error('This real TTY acceptance currently requires Linux util-linux script');
  const dsh = binaryOption('--dsh-bin');
  assert.equal(command(dsh, ['--version'], repo), contract.components.dsh.package.version);
  assert.equal(command('pnpm', ['--version'], repo), contract.runtime.pnpm);
  command('script', ['--version'], repo);
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
    console.log(JSON.stringify({ result: 'pass', scenarios: scenarios.map(scenario => scenario.name),
      approvals: true, toolResults: true, realTty: true }));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

await main().catch(error => {
  console.error(JSON.stringify({ result: 'fail', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
