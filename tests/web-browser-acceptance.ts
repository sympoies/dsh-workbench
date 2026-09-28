import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { startApprovalMockLlmServer } from './approval-mock.ts';
import headless from '@xterm/headless';
import * as pty from 'node-pty';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import type { WorkbenchContract } from '../src/contract-types.ts';
import { workbenchIdentity } from '../web/src/identity.ts';
import { readEvents } from './session-events.ts';
import { configureOwnerBackend } from './owner-backend.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(join(repo, 'compatibility/workbench.json'), 'utf8')) as WorkbenchContract;
const installedHome = process.argv.includes('--installed-dsh-home') ? option('--installed-dsh-home') : undefined;
const runtimeEnvFile = process.argv.includes('--runtime-env-file') ? option('--runtime-env-file') : undefined;
const ownerEnvFile = process.argv.includes('--owner-environment-file')
  ? option('--owner-environment-file') : undefined;
if (ownerEnvFile && !installedHome) throw new Error('Owner environment fixture requires an installed home');
assert.equal(Boolean(installedHome), Boolean(runtimeEnvFile),
  'Installed home and runtime environment file must be provided together');
if (installedHome) assert.equal(readFileSync(join(installedHome, '.workbench-terminal-acceptance'), 'utf8'),
  'disposable CI profile\n', 'Installed acceptance requires an owner-marked disposable home');
const runtimeEnvironment = runtimeEnvFile ? JSON.parse(readFileSync(runtimeEnvFile, 'utf8')) as NodeJS.ProcessEnv : {};
if (installedHome) assert.equal(realpathSync(runtimeEnvironment.DSH_HOME!), realpathSync(installedHome),
  'Runtime environment and installed home must identify the same disposable installation');
const managerEnvironment: NodeJS.ProcessEnv = {};
for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) {
  if (process.env[name]) managerEnvironment[name] = process.env[name];
}
const tuiProfile = installedHome ? 'workbench' : 'dsh-tui';
const webProfile = installedHome ? 'workbench' : 'web';
const answer = 'WORKBENCH_SMOKE_OK';
const prompts = ['FIRST_FIXTURE_PROMPT', 'SECOND_FIXTURE_PROMPT'] as const;
const errorPrompt = 'ERROR_FIXTURE_PROMPT';
const editorName = 'Describe what you want to build, / commands, @ files or sessions';
const tuiPrompt = 'TUI_TO_WEB_RENAMED_PROMPT';
const tuiAnswer = 'TUI_TO_WEB_RENAMED_ANSWER';
const tuiTitle = 'TUI_TO_WEB_MANUAL_TITLE';
const firstTuiMarkers = { prompt: tuiPrompt, answer: tuiAnswer, title: tuiTitle };
const secondTuiMarkers = { prompt: 'SECOND_WORKSPACE_TUI_PROMPT',
  answer: 'SECOND_WORKSPACE_TUI_ANSWER', title: 'SECOND_WORKSPACE_TUI_TITLE' };
const continuationPrompt = 'WEB_TO_TUI_CONTINUATION_PROMPT';
const continuationAnswer = 'WEB_TO_TUI_CONTINUATION_ANSWER';
const interruptedPrompt = 'WEB_APPROVAL_CRASH_PROMPT';
const recoveredPrompt = 'INTERRUPTED_WEB_TO_TUI_PROMPT';
const recoveredAnswer = 'INTERRUPTED_WEB_TO_TUI_ANSWER';
const imageName = 'workbench-handoff.png';
const imagePrompt = 'WEB_IMAGE_HANDOFF_PROMPT';
const imageContinuationPrompt = 'TUI_IMAGE_HANDOFF_CONTINUATION';
const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHUlEQVQ4y2M0Tpv5n4ECwESJ5lEDRg0YNWAwGQAAJeECUeW0yNsAAAAASUVORK5CYII=',
  'base64');
const legacyPrompt = 'LEGACY_V2_PROMPT';
const legacyAnswer = 'LEGACY_V2_ANSWER';
const legacyContinuationPrompt = 'LEGACY_V2_TUI_CONTINUATION';

function zstdFrame(content: string): Buffer {
  const result = spawnSync('zstd', ['-q', '-c'], { input: content, maxBuffer: 1_000_000 });
  assert.equal(result.error, undefined, 'zstd could not start for the legacy fixture');
  assert.equal(result.status, 0, 'zstd could not encode the legacy fixture');
  assert.ok(Buffer.isBuffer(result.stdout));
  return result.stdout;
}

function seedLegacyV2Copy(fixture: string, home: string, workspace: string, existingId: string) {
  const id = randomUUID();
  const project = dirname(dirname(sessionLog(join(home, 'sessions'), existingId)));
  const directory = join(project, id);
  const source = join(directory, 'session.v2.jsonl.zstd');
  const current = join(directory, 'session.v4.jsonl.zstd');
  const header = { type: 'session', version: 2, id, createdAt: Date.now(), cwd: realpathSync(workspace),
    isSeeded: false, delegationDepth: 0 };
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 3, surfaceOp: 'append',
      data: { id: 'legacy-user', role: 'user', content: [{ type: 'text', text: legacyPrompt }],
        source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 3, time: 4, surfaceOp: 'append',
      data: { turn: 1, step: 1,
        message: { id: 'legacy-assistant', role: 'assistant',
          content: [{ type: 'text', text: legacyAnswer }],
          source: { kind: 'model', provider: 'mock', model: 'mock' } },
        stream: [
          { type: 'chunk', time: 3, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'text-chunks', time0: 3, index: 0, dt: [], texts: [legacyAnswer] },
          { type: 'chunk', time: 4, chunk: { type: 'block-end', index: 0,
            block: { type: 'text', text: legacyAnswer } } },
          { type: 'chunk', time: 4, chunk: { type: 'finish', reason: { kind: 'stop' } } },
        ] } },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const original = Buffer.concat([zstdFrame(`${JSON.stringify(header)}\n`),
    zstdFrame(events.map(event => JSON.stringify(event)).join('\n') + '\n')]);
  mkdirSync(directory, { recursive: true });
  writeFileSync(source, original, { flag: 'wx' });
  const backup = join(fixture, 'legacy-backup', 'sessions', relative(join(home, 'sessions'), source));
  mkdirSync(dirname(backup), { recursive: true });
  copyFileSync(source, backup);
  return { id, source, current, backup, original };
}

function inlineImages(body: unknown): string[] {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap(message => {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap(part => {
      const image = part as { type?: unknown; source?: {
        type?: unknown; media_type?: unknown; data?: unknown;
      } } | null;
      return image?.type === 'image' && image.source?.type === 'base64' &&
        image.source.media_type === 'image/png' && typeof image.source.data === 'string'
        ? [image.source.data] : [];
    });
  });
}

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
  throw new Error(`TUI did not reach ${label}; screen: ${visibleScreen(tui.screen).slice(-600)}`);
}

function visibleScreen(screen: InstanceType<typeof headless.Terminal>): string {
  return Array.from({ length: screen.rows }, (_, row) =>
    screen.buffer.active.getLine(screen.buffer.active.viewportY + row)?.translateToString(true) ?? '').join('\n');
}

function startTui(dsh: string, fixture: string, home: string, agents: string, workspace: string,
  baseURL: string, apiKey: string, args: string[] = []) {
  configureOwnerBackend(ownerEnvFile, baseURL, apiKey);
  const child = pty.spawn(dsh, ['--profile', tuiProfile, ...args], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: workspace,
    env: { ...runtimeEnvironment, ...managerEnvironment, PATH: `${dirname(dsh)}:${process.env.PATH ?? ''}`, HOME: home, DSH_HOME: home,
      DSH_AGENTS_HOME: agents, XDG_CONFIG_HOME: runtimeEnvironment.XDG_CONFIG_HOME ?? join(fixture, 'config'),
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
  agents: string, workspace: string, userConfig: string, globalConfig: string,
  markers = firstTuiMarkers): Promise<string> {
  if (!installedHome) {
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
  }
  const apiKey = randomBytes(24).toString('hex');
  const mock = await startMockLlmServer({ sequence: ['success'], repeatLast: true,
    apiKey, successText: markers.answer });
  const logRoot = join(home, 'sessions');
  mkdirSync(logRoot, { recursive: true });
  const previous = new Set(sessionLogs(logRoot));
  const tui = startTui(dsh, fixture, home, agents, workspace, mock.baseURL, apiKey);
  try {
    await waitForTui(tui, () => visibleScreen(tui.screen).includes('Explore the uncharted!'), 'startup');
    tui.write(`${markers.prompt}\r`);
    let logPath: string | undefined;
    await waitForTui(tui, () => {
      const added = sessionLogs(logRoot).filter(path => !previous.has(path));
      if (added.length !== 1) return false;
      logPath = added[0];
      return readEvents(logPath).some(event => event.type === 'turn/end');
    }, 'settled first turn');
    tui.write(`/rename ${markers.title}\r`);
    await waitForTui(tui, () => readEvents(logPath!).some(event =>
      event.type === 'session/title' && event.data?.title === markers.title), 'manual title');
    await waitForTui(tui, () => visibleScreen(tui.screen).includes(`Renamed to "${markers.title}"`), 'durable rename acknowledgement');
    await tui.stop();
    assert.equal(tui.exitCode, 0, 'TUI did not exit cleanly before Web handoff');
    const events = readEvents(logPath!, { strict: true });
    assert.deepEqual(events.filter(event => event.type === 'session/title').at(-1)?.data,
      { title: markers.title, messageSeqs: [], source: { kind: 'user' } });
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

async function continueLegacyV2InTui(dsh: string, fixture: string, home: string, agents: string,
  workspace: string, legacy: ReturnType<typeof seedLegacyV2Copy>,
  mock: Awaited<ReturnType<typeof startMockLlmServer>>,
  apiKey: string): Promise<void> {
  const requestsBefore = mock.requests.length;
  const tui = startTui(dsh, fixture, home, agents, workspace, mock.baseURL, apiKey,
    ['--resume', legacy.id]);
  try {
    await waitForTui(tui, () => visibleScreen(tui.screen).includes(legacyAnswer),
      'restored legacy answer');
    tui.write(`${legacyContinuationPrompt}\r`);
    await waitForTui(tui, () => existsSync(legacy.current) &&
      readEvents(legacy.current).filter(event => event.type === 'turn/end').length === 2,
    'completed legacy continuation in Session V4');
    await tui.stop();
    assert.equal(tui.exitCode, 0, 'TUI did not exit cleanly after legacy migration');
    const events = readEvents(legacy.current, { strict: true });
    assert.ok(JSON.stringify(events).includes(legacyPrompt), 'the migrated V4 log lost the old prompt');
    assert.ok(JSON.stringify(events).includes(legacyAnswer), 'the migrated V4 log lost the old answer');
    assert.ok(JSON.stringify(events).includes(legacyContinuationPrompt),
      'the migrated V4 log lost the TUI continuation');
    const continuationRequest = mock.requests.slice(requestsBefore).find(request =>
      JSON.stringify(request.body).includes(legacyContinuationPrompt));
    assert.ok(continuationRequest, 'the migrated TUI turn did not reach the model');
    const messages = (continuationRequest.body as { messages?: unknown }).messages;
    assert.ok(Array.isArray(messages), 'the migrated model request has no messages');
    const roles = messages.map(message => (message as { role?: unknown }).role);
    const oldUser = messages.findIndex((message, index) => roles[index] === 'user' &&
      JSON.stringify(message).includes(legacyPrompt));
    const oldAssistant = messages.findIndex((message, index) => index > oldUser &&
      roles[index] === 'assistant' && JSON.stringify(message).includes(legacyAnswer));
    const newUser = messages.findIndex((message, index) => index > oldAssistant &&
      roles[index] === 'user' && JSON.stringify(message).includes(legacyContinuationPrompt));
    assert.ok(oldUser >= 0 && oldAssistant > oldUser && newUser > oldAssistant,
      'the migrated model request lost or reordered the historical conversation');
    assert.ok(readFileSync(legacy.source).equals(legacy.original),
      'migration changed the historical source bytes');
    assert.ok(readFileSync(legacy.backup).equals(legacy.original),
      'migration changed the isolated rollback copy');
  } finally {
    await tui.stop();
  }
}

async function checkImageHandoffInTui(dsh: string, fixture: string, home: string, agents: string,
  workspace: string, id: string, mock: Awaited<ReturnType<typeof startMockLlmServer>>,
  apiKey: string, webImagePayload: string): Promise<void> {
  const logRoot = join(home, 'sessions');
  const logPath = sessionLog(logRoot, id);
  const previous = new Set(sessionLogs(logRoot));
  const requestsBefore = mock.requests.length;
  const turnsBefore = readEvents(logPath, { strict: true })
    .filter(event => event.type === 'turn/end').length;
  const tui = startTui(dsh, fixture, home, agents, workspace, mock.baseURL, apiKey,
    ['--resume', id]);
  try {
    await waitForTui(tui, () => visibleScreen(tui.screen).includes(answer),
      'settled Web answer in the resumed TUI transcript');
    tui.write(`${imageContinuationPrompt}\r`);
    await waitForTui(tui, () => readEvents(logPath).filter(event =>
      event.type === 'turn/end').length === turnsBefore + 1,
    'completed image-session TUI continuation');
    await tui.stop();
    assert.equal(tui.exitCode, 0, 'TUI did not exit cleanly after image handoff');
    assert.deepEqual(sessionLogs(logRoot).filter(path => !previous.has(path)), [],
      'Image handoff created another session');
    const events = readEvents(logPath, { strict: true });
    assert.ok(JSON.stringify(events.filter(event => event.type === 'user/message'))
      .includes(imageContinuationPrompt), 'TUI continuation did not persist under the image session');
    assert.equal((events.filter(event => event.type === 'turn/end').at(-1)?.data?.reason as
      { kind?: string } | undefined)?.kind, 'completed');
    const continuationRequest = mock.requests.slice(requestsBefore).find(request =>
      JSON.stringify(request.body).includes(imageContinuationPrompt));
    assert.ok(continuationRequest, 'TUI continuation did not reach the model');
    assert.ok(inlineImages(continuationRequest.body).includes(webImagePayload),
      'TUI continuation did not send the durable Web image to the model');
  } finally {
    await tui.stop();
  }
}

async function continueInterruptedWebSessionInTui(dsh: string, fixture: string, home: string,
  agents: string, workspace: string, id: string): Promise<void> {
  const logRoot = join(home, 'sessions');
  const logPath = sessionLog(logRoot, id);
  const before = readEvents(logPath, { strict: true });
  assert.ok(before.some(event => event.type === 'turn/start'),
    'crashed Web turn was not durable before TUI resume');
  assert.ok(!before.some(event => event.type === 'turn/end'),
    'the approval turn settled before the Web Host crash');
  const previous = new Set(sessionLogs(logRoot));
  const apiKey = randomBytes(24).toString('hex');
  const marker = join(workspace, `recovered-approval-execution-count-${id}`);
  const escapedMarker = "'" + marker.replaceAll("'", "'\\''") + "'";
  const toolOutput = 'RECOVERED_BASH_EXECUTED';
  const mock = await startApprovalMockLlmServer({
    sequence: ['success', 'tool_call_success', 'success', 'tool_call_success', 'success'],
    repeatLast: true, apiKey, successText: recoveredAnswer, toolName: 'bash',
    toolArguments: JSON.stringify({ command: `printf 'executed\\n' >> ${escapedMarker} && printf ${toolOutput}`,
      description: 'Count recovered-session Bash executions', sandbox_permissions: 'danger-full-access',
      justification: 'Verify fresh approvals in a disposable recovered session' }),
  }, recoveredAnswer);
  const tui = startTui(dsh, fixture, home, agents, workspace, mock.baseURL, apiKey,
    ['--resume', id]);
  try {
    await waitForTui(tui, () => readEvents(logPath).some(event =>
      event.type === 'turn/end'
      && (event.data?.reason as { kind?: string } | undefined)?.kind === 'interrupted'),
    'durable interrupted-turn closure');
    await waitForTui(tui, () => visibleScreen(tui.screen).includes(recoveredAnswer),
      'completed interrupted-session recap');
    tui.write(`${recoveredPrompt}\r`);
    await waitForTui(tui, () => JSON.stringify(readEvents(logPath)
      .filter(event => event.type === 'user/message')).includes(recoveredPrompt),
    'persisted post-crash TUI prompt');
    await waitForTui(tui, () => mock.requests.length >= 1,
      'post-crash TUI continuation model request');
    await waitForTui(tui, () => readEvents(logPath).filter(event => event.type === 'turn/end').length === 2,
      'completed post-crash TUI continuation');
    assert.equal(existsSync(marker), false, 'Recovery recap executed the fresh Bash command');
    const approvalIds = new Set(before.filter(event => event.type === 'approval/asked')
      .map(event => event.data?.id));
    for (const [index, scenario] of [
      { prompt: 'RECOVERED_BASH_ALLOW', decision: '1', outcome: 'allowed-once', isError: false },
      { prompt: 'RECOVERED_BASH_REJECT', decision: '\x1b', outcome: 'rejected', isError: true },
    ].entries()) {
      const start = readEvents(logPath, { strict: true }).length;
      tui.write(`${scenario.prompt}\r`);
      await waitForTui(tui, () => readEvents(logPath).slice(start)
        .some(event => event.type === 'approval/asked'), 'fresh recovered Bash approval');
      await waitForTui(tui, () => visibleScreen(tui.screen).includes('Awaiting approval · bash')
        && visibleScreen(tui.screen).includes('Yes, allow once'), 'rendered recovered Bash choice');
      tui.write(scenario.decision);
      await waitForTui(tui, () => readEvents(logPath).filter(event => event.type === 'turn/end')
        .length === index + 3, 'completed recovered Bash turn');
      const turn = readEvents(logPath, { strict: true }).slice(start);
      const asked = turn.filter(event => event.type === 'approval/asked');
      const decided = turn.filter(event => event.type === 'approval/decided');
      const results = turn.filter(event => event.type === 'tool/result');
      assert.equal(asked.length, 1);
      assert.equal(asked[0]?.data?.toolName, 'bash');
      const approvalId = asked[0]?.data?.id;
      assert.equal(typeof approvalId, 'string');
      assert.ok(!approvalIds.has(approvalId), 'Recovered Bash reused an old approval identity');
      approvalIds.add(approvalId);
      assert.equal(decided.length, 1);
      assert.equal(decided[0]?.data?.id, approvalId);
      assert.equal(decided[0]?.data?.outcome, scenario.outcome);
      assert.equal(results.length, 1);
      const message = results[0]?.data?.message as { isError?: boolean; content?: unknown } | undefined;
      assert.equal(message?.isError, scenario.isError);
      const content = JSON.stringify(message?.content);
      assert.ok(scenario.isError ? content.includes('the user rejected escalating this command')
        : content.includes(toolOutput));
      if (scenario.isError) assert.ok(!content.includes(toolOutput));
      assert.equal((turn.find(event => event.type === 'turn/end')?.data?.reason as
        { kind?: string } | undefined)?.kind, 'completed');
      assert.equal(readFileSync(marker, 'utf8'), 'executed\n',
        'Fresh allow must execute once and fresh reject must leave the count unchanged');
    }
    await tui.stop();
    assert.equal(tui.exitCode, 0, 'TUI did not exit cleanly after interrupted Web handoff');
    assert.deepEqual(sessionLogs(logRoot).filter(path => !previous.has(path)), [],
      'Interrupted-turn TUI resume created another session');
    const events = readEvents(logPath, { strict: true });
    assert.deepEqual(events.slice(0, before.length), before, 'Recovery rewrote pre-crash history');
    const endedTurns = events.filter(event => event.type === 'turn/end');
    assert.deepEqual(events.filter(event => event.type === 'approval/decided')
      .map(event => event.data?.outcome), ['allowed-once', 'rejected'],
    'Recovered session must prove fresh Bash allow and reject');
    assert.equal((endedTurns.at(-1)?.data?.reason as { kind?: string } | undefined)?.kind, 'completed',
      'the post-crash TUI continuation did not complete');
    assert.ok(JSON.stringify(events.filter(event => event.type === 'user/message')).includes(interruptedPrompt));
    assert.ok(JSON.stringify(events.filter(event => event.type === 'user/message')).includes(recoveredPrompt));
    const continuationPromptIndex = events.findIndex(event => event.type === 'user/message'
      && JSON.stringify(event).includes(recoveredPrompt));
    assert.ok(continuationPromptIndex >= 0 && events.slice(continuationPromptIndex + 1).some(event =>
      event.type === 'assistant/message'
        && JSON.stringify(event).includes(recoveredAnswer)),
    `the completed post-crash TUI continuation did not persist an answer after its prompt: ${JSON.stringify((() => {
      const start = Math.max(0, continuationPromptIndex - 3);
      return {
        eventCount: events.length,
        promptIndex: continuationPromptIndex,
        aroundPrompt: events.slice(start, start + 9).map(event => ({
          type: event.type,
          reason: event.type === 'turn/end' ? event.data?.reason : undefined,
          prompt: event.type === 'user/message' && JSON.stringify(event).includes(recoveredPrompt),
          answer: event.type === 'assistant/message' && JSON.stringify(event).includes(recoveredAnswer),
          fields: event.data === null || typeof event.data !== 'object' ? [] : Object.keys(event.data).slice(0, 4),
        })),
      };
    })())}`);
    assert.ok(mock.requests.length >= 5,
      'TUI did not request the text continuation and both recovered Bash turns');
  } finally {
    const cleanup = await Promise.allSettled([tui.stop(), mock.close()]);
    if (cleanup.some(result => result.status === 'rejected')) throw new Error('Interrupted-turn cleanup failed');
  }
}

async function checkWebWriterContention(dsh: string, fixture: string, home: string, agents: string,
  workspace: string, id: string, baseURL: string, apiKey: string,
  archiveState: 'settled' | 'pending' = 'settled'): Promise<void> {
  const logPath = sessionLog(join(home, 'sessions'), id);
  const before = readFileSync(logPath);
  const tui = startTui(dsh, fixture, home, agents, workspace, baseURL, apiKey,
    ['--resume', id]);
  try {
    const exit = await tui.waitForExit(20_000);
    assert.notEqual(exit, 0, 'TUI did not refuse the Web-held writer with an error');
    const after = readFileSync(logPath);
    if (archiveState === 'settled') {
      assert.ok(after.equals(before), 'Rejected TUI access changed the settled Web-held archive');
    } else {
      assert.ok(after.subarray(0, before.length).equals(before),
        'Rejected TUI access rewrote the pending Web-held archive');
    }
  } finally {
    await tui.stop();
  }
}

async function startHost(binary: string, home: string, agents: string, workspace: string,
  baseURL: string, apiKey: string) {
  configureOwnerBackend(ownerEnvFile, baseURL, apiKey);
  const child = spawn(binary, ['--profile', webProfile, '--host', '127.0.0.1', '--no-open', '--port', '0'], {
    cwd: workspace,
    env: {
      ...runtimeEnvironment, ...managerEnvironment,
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
    const diagnostic = () => `errorLines=${errorLines}; `
      + `sessionIdentityError=${stderr.includes('assertStoredIdentity')}; `
      + `corruptArchiveError=${stderr.includes('corrupt session log')}`;
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

async function crashHost(child: ChildProcess): Promise<void> {
  assert.equal(child.exitCode, null, 'Web Host exited before the crash-recovery check');
  assert.equal(child.signalCode, null, 'Web Host already received a termination signal');
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Web Host survived SIGKILL'));
    }, 10_000);
    const onExit = (_code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') resolveExit();
      else reject(new Error(`Web Host exited through ${signal ?? 'another path'} instead of SIGKILL`));
    };
    child.once('exit', onExit);
    if (!child.kill('SIGKILL')) {
      clearTimeout(timer);
      child.off('exit', onExit);
      reject(new Error('Could not terminate the Web Host for crash recovery'));
    }
  });
}

async function openPage(browser: Browser, host: Awaited<ReturnType<typeof startHost>>): Promise<{ page: Page; errors: string[] }> {
  const exchange = await fetch(host.url, { redirect: 'manual' });
  assert.equal(exchange.status, 303, `DSH Web Host rejected its complete launch token: HTTP ${exchange.status}`);
  assert.equal(new URL(exchange.headers.get('location') ?? '', host.url).href,
    new URL('/', host.url).href, 'DSH Web Host did not redirect to the root after launch token exchange');
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
  if (await continueButton.isVisible()) {
    await continueButton.click();
    await page.getByRole('dialog', { name: 'Internal Testing Notice' })
      .waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {
        throw new Error('WORKBENCH_WEB_WELCOME_ACK_FAILED: acknowledgement did not persist');
      });
  }
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  return { page, errors };
}

async function listedSessionIds(page: Page): Promise<{ status: number; ids: string[];
  locations: Array<{ sessionId: string; cwd?: string }>; errorCode?: string }> {
  return page.evaluate(async () => {
    const response = await fetch('/api/session/list', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'legacy-copy-list',
        method: 'session/list', payload: { args: { _request: {} } } }),
    });
    const body = await response.json() as { result?: {
      value?: { items?: Array<{ sessionId?: string; cwd?: string }> }; error?: { code?: string };
    } };
    return { status: response.status,
      ids: body.result?.value?.items?.flatMap(item => item.sessionId ? [item.sessionId] : []) ?? [],
      locations: body.result?.value?.items?.flatMap(item => item.sessionId
        ? [{ sessionId: item.sessionId, cwd: item.cwd }] : []) ?? [],
      errorCode: body.result?.error?.code };
  });
}

async function revealSessionRow(page: Page, id: string): Promise<Locator> {
  const row = page.locator(`[data-row-key="session:${id}"]`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await row.isVisible()) return row;
    const workspace = page.locator('[data-row-key^="workspace:"][aria-expanded="false"]').first();
    if (await workspace.isVisible()) await workspace.click();
    const expand = page.locator('button[data-row-key^="overflow:"][aria-expanded="false"]').first();
    if (await expand.isVisible()) await expand.click();
    await page.waitForTimeout(250);
  }
  const state = await page.evaluate(() => ({
    sessionRows: document.querySelectorAll('[data-row-key^="session:"]').length,
    workspaceRows: document.querySelectorAll('[data-row-key^="workspace:"]').length,
    collapsedWorkspaces: document.querySelectorAll('[data-row-key^="workspace:"][aria-expanded="false"]').length,
    hiddenOverflow: document.querySelectorAll('button[data-row-key^="overflow:"][aria-expanded="false"]').length,
    alerts: document.querySelectorAll('[role="alert"]').length,
  }));
  throw new Error(`The session list did not reveal session ${id}: ${JSON.stringify(state)}`);
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
  assert.ok(title.includes(workbenchIdentity.graphDigest), 'Web plugin did not report the exact graph digest');
  assert.ok(title.includes(`Workbench ${contract.release.version}`));
  assert.doesNotMatch(title, /\((?:candidate|accepted)\)/,
    'Web artifact must not advertise an acceptance verdict');
  assert.ok(title.includes(`DSH ${contract.components.dsh.package.version}`));
  assert.ok(title.includes(contract.components.runtimeKit.source.commit));
  assert.ok(title.includes(`TUI ${contract.components.tui.package.version}`));
  await button.click();
  const id = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(/^(?:session-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id),
    'copied ID is not a DSH session ID');
  return id;
}

async function startNewSession(page: Page, phase: string, completedIds: readonly string[]): Promise<{
  editor: Locator; checkIdentity: (id: string) => void;
}> {
  const checkpoint = (step: string): void => console.log(JSON.stringify({ event: 'new-session', phase, step }));
  checkpoint('read-current-id');
  const copy = page.getByRole('button', { name: 'Copy Session ID for TUI' });
  const hero = page.getByText('Into the Unknown', { exact: true });
  await Promise.any([
    copy.waitFor({ timeout: 30_000 }),
    hero.waitFor({ timeout: 30_000 }),
  ]);
  const previous = await copy.isVisible() ? await copiedSessionId(page) : null;
  if (previous === null) await hero.waitFor({ timeout: 30_000 });
  checkpoint('click-native-new-session');
  const createResponses: number[] = [];
  const createCodes: string[] = [];
  const createCauses: unknown[] = [];
  const pendingResponses: Promise<void>[] = [];
  const creationErrors: unknown[] = [];
  let creationWarning = false;
  const onResponse = (response: import('playwright-core').Response): void => {
    if (new URL(response.url()).pathname !== '/api/session/create') return;
    createResponses.push(response.status());
    pendingResponses.push(response.json().then((body: unknown) => {
      const inspect = (value: unknown, depth: number): void => {
        if (depth > 5 || value === null || typeof value !== 'object') return;
        for (const [key, nested] of Object.entries(value)) {
          if (key === 'code' && typeof nested === 'string' && /^[a-z0-9/_-]{1,100}$/i.test(nested)) createCodes.push(nested);
          else if (key === 'message' && typeof nested === 'string') {
            createCauses.push({ duplicateGlobalTool:
              nested.includes('(for a per-agent variant, register through that agent') });
          }
          else inspect(nested, depth + 1);
        }
      };
      inspect(body, 0);
    }).catch(() => {}));
  };
  const onConsole = (message: import('playwright-core').ConsoleMessage): void => {
    if (!message.text().startsWith('new session failed:')) return;
    creationWarning = true;
    for (const argument of message.args().slice(1)) pendingResponses.push(argument.evaluate(value => {
      if (!(value instanceof Error)) return { kind: 'non-error' };
      const categories = ['sessions.retain: unknown session', 'Session Controller is disposed',
        'Session reference', 'session create failed:', 'The operation was aborted'];
      return { name: value.name, category: categories.find(prefix => value.message.startsWith(prefix)) ?? 'other',
        functions: (value.stack ?? '').split('\n').flatMap(line => {
          const match = /^\s*at ([\w$.]+) \(/.exec(line);
          return match ? [match[1]] : [];
        }).slice(0, 8) };
    }).then(value => { creationErrors.push(value); }).catch(() => {}));
  };
  page.on('response', onResponse);
  page.on('console', onConsole);
  await page.getByRole('button', { name: 'New Session' }).first().click();
  // Native DSH deliberately hides header utilities until the blank session
  // receives its first message. Verify its blank view now and its ID afterward.
  try {
    await hero.waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Choose workspace', exact: true }).waitFor({ timeout: 30_000 });
  } catch {
    await Promise.all(pendingResponses);
    const current = await copy.isVisible() ? await copiedSessionId(page) : null;
    throw new Error(`${phase}: native New Session did not reach its blank view: ${JSON.stringify({
      createResponses, createCodes, createCauses, creationWarning, creationErrors, retainedPreviousIdentity: previous !== null && current === previous,
      userMessages: await page.locator('[data-conversation-content] [data-chat-flow-kind="user"]').count(),
      alerts: await page.getByRole('alert').count(),
    })}`);
  } finally {
    page.off('response', onResponse);
    page.off('console', onConsole);
  }
  await copy.waitFor({ state: 'hidden', timeout: 30_000 });
  assert.equal(await page.locator('[data-conversation-content] [data-chat-flow-kind="user"]').count(), 0,
    `${phase}: New Session retained conversation messages`);
  const editor = page.getByRole('textbox', { name: editorName });
  await editor.waitFor({ timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  while ((await editor.textContent())?.trim() !== '' && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  assert.equal((await editor.textContent())?.trim(), '', 'new session composer retained the previous prompt');
  checkpoint('blank-view-and-empty-editor-verified');
  return { editor, checkIdentity: id => {
    assert.ok(previous === null || id !== previous, `${phase}: New Session did not replace the current session`);
    assert.ok(!completedIds.includes(id), `${phase}: New Session reused a completed session`);
    checkpoint('new-identity-verified');
  } };
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

async function checkTuiHandoff(page: Page, id: string,
  markers = firstTuiMarkers, other?: typeof firstTuiMarkers): Promise<void> {
  const row = await revealSessionRow(page, id);
  // A cold Web list must show the durable manual title before hydration.
  await row.getByText(markers.title, { exact: true }).waitFor({ timeout: 30_000 });
  await row.click();
  assert.equal(await copiedSessionId(page), id, 'Web opened another TUI session ID');
  const conversation = page.locator('[data-conversation-content]');
  await conversation.getByText(markers.prompt, { exact: false }).first().waitFor({ timeout: 30_000 });
  const body = await conversation.innerText();
  assert.ok(body.includes(markers.prompt), 'Web lost the TUI prompt');
  assert.ok(body.includes(markers.answer), 'Web lost the TUI answer');
  if (other) {
    assert.ok(!body.includes(other.prompt) && !body.includes(other.answer),
      'Web mixed histories across canonical workspaces');
  }
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
  if (installedHome && !process.argv.includes('--tui-bin')) throw new Error('WORKBENCH_TUI_ENTRY_REQUIRED: installed handoff requires the Workbench TUI entry');
  const tuiDsh = process.argv.includes('--tui-bin') ? option('--tui-bin') : dsh;
  const browserBin = option('--browser-bin');
  assert.equal(command(dsh, ['--version'], repo, 300_000, { ...process.env, ...runtimeEnvironment }),
    contract.components.dsh.package.version);
  assert.equal(command('pnpm', ['--version'], repo), contract.runtime.pnpm);
  command('pnpm', ['web:build'], repo);

  const fixture = mkdtempSync(join(tmpdir(), 'dsh-workbench-web-'));
  const home = installedHome ?? join(fixture, 'home');
  const agents = join(fixture, 'agents');
  const workspace = runtimeEnvFile ? join(dirname(runtimeEnvFile), 'workspace') : join(fixture, 'workspace');
  const profile = join(home, 'profiles', webProfile);
  for (const directory of [home, agents, workspace, profile]) mkdirSync(directory, { recursive: true });
  let mock: Awaited<ReturnType<typeof startMockLlmServer>> | undefined;
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  let browser: Browser | undefined;
  let pageErrors = 0;
  let hostErrors = 0;
  try {
    if (!installedHome) {
      const packed = command('pnpm', ['pack', '--pack-destination', fixture], join(repo, 'web'));
      const archive = resolve(fixture, packed.split('\n').at(-1)!);
      mkdirSync(join(profile, 'patches'), { recursive: true });
      writeFileSync(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-workbench-web-browser-acceptance', private: true, type: 'module',
        dependencies: {
          '@sympoies/dsh-workbench-web': `file:${relative(profile, archive)}`,
          [contract.components.tui.package.name]: contract.components.tui.package.version,
        },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
          contract.components.tui.package.name] } },
      }, null, 2));
      writeFileSync(join(profile, 'pnpm-workspace.yaml'),
        command(process.execPath, [join(repo, 'scripts/tui-compat.mjs')], repo));
      copyFileSync(join(repo, contract.components.tui.compatibilityPatch!.path),
        join(profile, 'patches/tui-rename.patch'));
      writeFileSync(join(profile, 'cordis.patch.yml'),
        "- insert:\n    - id: dsh-workbench-web\n      name: '@sympoies/dsh-workbench-web'\n");
    }
    const userConfig = join(fixture, 'user.npmrc');
    const globalConfig = join(fixture, 'global.npmrc');
    writeFileSync(userConfig, '');
    writeFileSync(globalConfig, '');
    if (!installedHome) {
      command('pnpm', ['install', '--strict-peer-dependencies', '--ignore-scripts',
        '--reporter', 'append-only'], profile, 300_000, {
        PATH: process.env.PATH ?? '',
        LANG: process.env.LANG ?? 'C.UTF-8',
        HOME: home,
        XDG_CONFIG_HOME: join(fixture, 'config'),
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
      });
    }

    const tuiSessionId = await seedTuiRenamedSession(tuiDsh, fixture, home, agents,
      workspace, userConfig, globalConfig);
    const otherWorkspace = join(fixture, 'second-workspace');
    mkdirSync(otherWorkspace, { recursive: true });
    const secondWorkspaceSessionId = await seedTuiRenamedSession(tuiDsh, fixture, home, agents,
      otherWorkspace, userConfig, globalConfig, secondTuiMarkers);
    assert.notEqual(secondWorkspaceSessionId, tuiSessionId);

    const apiKey = randomBytes(24).toString('hex');
    mock = await startApprovalMockLlmServer({ sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
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
    const crossWorkspaceList = await listedSessionIds(firstPage);
    assert.equal(crossWorkspaceList.status, 200);
    assert.equal(crossWorkspaceList.errorCode, undefined);
    assert.equal(crossWorkspaceList.locations.find(item => item.sessionId === tuiSessionId)?.cwd,
      realpathSync(workspace), 'Web did not retain the first TUI session workspace');
    assert.equal(crossWorkspaceList.locations.find(item => item.sessionId === secondWorkspaceSessionId)?.cwd,
      realpathSync(otherWorkspace), 'Web did not retain the second TUI session workspace');
    await checkTuiHandoff(firstPage, secondWorkspaceSessionId, secondTuiMarkers, firstTuiMarkers);
    await checkTuiHandoff(firstPage, tuiSessionId, firstTuiMarkers, secondTuiMarkers);
    const { editor, checkIdentity: checkFirstIdentity } = await startNewSession(firstPage, 'first',
      [tuiSessionId, secondWorkspaceSessionId]);
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
    const pendingId = await copiedSessionId(firstPage);
    checkFirstIdentity(pendingId);
    await checkWebWriterContention(tuiDsh, fixture, home, agents, workspace, pendingId,
      mock.baseURL, apiKey, 'pending');
    assert.ok(await approval.isVisible(), 'Web approval disappeared after refused TUI resume');
    await approval.getByRole('button', { name: 'Allow once' }).click();
    await firstPage.getByText('Worked', { exact: true }).first().waitFor({ timeout: 30_000 });
    const firstId = await copiedSessionId(firstPage);
    assert.equal(firstId, pendingId, 'Web approval completed in a different session');
    await checkToolResult(firstPage);

    // Auxiliary title requests use their own fixture sequence.
    await waitForMockRequests(mock, 2);

    const { editor: secondEditor, checkIdentity: checkSecondIdentity } = await startNewSession(firstPage, 'second', [tuiSessionId, firstId]);
    await secondEditor.fill(prompts[1]);
    await secondEditor.press('Enter');
    await approval.waitFor({ timeout: 30_000 });
    await approval.getByRole('button', { name: 'Reject' }).click();
    await approval.waitFor({ state: 'hidden', timeout: 30_000 });
    await firstPage.getByText('Worked', { exact: true }).first().waitFor({ timeout: 30_000 });
    const secondId = await copiedSessionId(firstPage);
    checkSecondIdentity(secondId);
    assert.ok(firstId !== secondId, 'two new sessions share an ID');
    await checkHistory(firstPage, firstId, prompts[0], prompts[1]);
    await checkHistory(firstPage, secondId, prompts[1], prompts[0]);
    await checkRejectedTool(firstPage);
    await checkHistory(firstPage, firstId, prompts[0], prompts[1]);
    await checkWebWriterContention(tuiDsh, fixture, home, agents, workspace, firstId, mock.baseURL, apiKey);
    pageErrors += firstErrors.length;
    hostErrors += host.errorCount();
    await crashHost(host.child);
    await browser.close();
    browser = undefined;
    host = undefined;

    await continueWebSessionInTui(tuiDsh, fixture, home, agents, workspace, firstId);

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
    const { editor: errorEditor, checkIdentity: checkErrorIdentity } = await startNewSession(errorPage, 'error', [tuiSessionId, firstId, secondId]);
    await errorEditor.fill(errorPrompt);
    await errorEditor.press('Enter');
    await errorPage.locator('[data-conversation-content]')
      .getByText('This turn failed', { exact: false }).first().waitFor({ timeout: 30_000 });
    const errorId = await copiedSessionId(errorPage);
    checkErrorIdentity(errorId);
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
    const errorRequests = mock.requests.length;

    await browser.close();
    browser = undefined;
    await stopHost(host.child);
    host = undefined;
    await mock.close();
    const approvalMarker = join(workspace, `interrupted-approval-command-executed-${randomUUID()}`);
    mock = await startApprovalMockLlmServer({ sequence: ['tool_call_success', 'success'],
      repeatLast: true, successText: answer, apiKey, toolName: 'bash',
      toolArguments: JSON.stringify({ command: `touch '${approvalMarker}'`,
        description: 'Require an approval before the crash',
        sandbox_permissions: 'danger-full-access',
        justification: 'Verify interrupted-turn recovery in a disposable workspace' }) });
    host = await startHost(dsh, home, agents, workspace, mock.baseURL, apiKey);
    browser = await launchBrowser(browserBin, home);
    const interruptedOpened = await openPage(browser, host);
    const { editor: interruptedEditor, checkIdentity: checkInterruptedIdentity } = await startNewSession(interruptedOpened.page, 'interrupted',
      [tuiSessionId, firstId, secondId, errorId]);
    await interruptedEditor.fill(interruptedPrompt);
    await interruptedEditor.press('Enter');
    const interruptedApproval = interruptedOpened.page.locator('[data-approval-key]');
    await interruptedApproval.waitFor({ timeout: 30_000 });
    const interruptedId = await copiedSessionId(interruptedOpened.page);
    checkInterruptedIdentity(interruptedId);
    await checkWebWriterContention(tuiDsh, fixture, home, agents, workspace, interruptedId,
      mock.baseURL, apiKey, 'pending');
    assert.ok(await interruptedApproval.isVisible(), 'Web approval vanished before the crash');
    pageErrors += interruptedOpened.errors.length;
    hostErrors += host.errorCount();
    await crashHost(host.child);
    await browser.close();
    browser = undefined;
    host = undefined;
    await mock.close();
    mock = undefined;

    await continueInterruptedWebSessionInTui(tuiDsh, fixture, home, agents, workspace, interruptedId);
    assert.equal(existsSync(approvalMarker), false,
      'the unapproved Web command executed during TUI recovery');

    mock = await startMockLlmServer({ sequence: ['success'], repeatLast: true,
      apiKey, successText: answer });
    host = await startHost(dsh, home, agents, workspace, mock.baseURL, apiKey);
    browser = await launchBrowser(browserBin, home);
    const recoveredOpened = await openPage(browser, host);
    const recoveredRow = recoveredOpened.page.locator(`[data-row-key="session:${interruptedId}"]`);
    await recoveredRow.waitFor({ timeout: 30_000 });
    await recoveredRow.click();
    assert.equal(await copiedSessionId(recoveredOpened.page), interruptedId,
      'Web reopened the interrupted session under another ID');
    const recoveredConversation = recoveredOpened.page.locator('[data-conversation-content]');
    await recoveredConversation.getByText(recoveredAnswer, { exact: false }).first()
      .waitFor({ timeout: 30_000 });
    await recoveredOpened.page.locator('[data-approval-key]')
      .waitFor({ state: 'hidden', timeout: 30_000 });
    const recovered = await recoveredConversation.innerText();
    assert.ok(recovered.includes(interruptedPrompt), 'Web lost the interrupted prompt');
    assert.ok(recovered.includes(recoveredPrompt), 'Web lost the post-crash TUI prompt');
    assert.ok(recovered.includes(recoveredAnswer), 'Web lost the post-crash TUI answer');
    assert.equal(existsSync(approvalMarker), false,
      'the unapproved Web command executed after Web reopened');
    pageErrors += recoveredOpened.errors.length;
    hostErrors += host.errorCount();
    assert.equal(pageErrors, 0, 'browser reported JavaScript errors');
    assert.equal(hostErrors, 0, 'DSH Web Host reported errors');

    const { editor: imageEditor, checkIdentity: checkImageIdentity } = await startNewSession(recoveredOpened.page, 'image',
      [tuiSessionId, firstId, secondId, errorId, interruptedId]);
    const modelTrigger = recoveredOpened.page.getByRole('button', { name: /^Select model, current/ });
    await modelTrigger.click();
    await recoveredOpened.page.getByRole('menuitem', { name: /^Model\b/ }).click();
    await recoveredOpened.page.getByRole('menuitemradio',
      { name: 'DeepSeek-V41-Flash' }).click();
    await recoveredOpened.page.locator('input[type="file"]').setInputFiles({
      name: imageName, mimeType: 'image/png', buffer: imageBytes,
    });
    await recoveredOpened.page.getByRole('group', { name: 'Pending attachments' })
      .getByRole('img', { name: imageName }).waitFor({ timeout: 30_000 });
    await imageEditor.fill(imagePrompt);
    const sendImage = recoveredOpened.page.getByRole('button', { name: 'Send message' });
    await sendImage.waitFor({ timeout: 30_000 });
    const readyDeadline = Date.now() + 30_000;
    while (!await sendImage.isEnabled() && Date.now() < readyDeadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    assert.equal(await sendImage.isEnabled(), true, 'image upload did not reach a sendable state');
    const imageHttp: string[] = [];
    recoveredOpened.page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/api/session/prompt') || path.endsWith('/api/session/attachment')) {
        imageHttp.push(path);
      }
    });
    recoveredOpened.page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (path.endsWith('/api/session/prompt') || path.endsWith('/api/session/attachment')) {
        imageHttp.push(`${path}:${response.status()}`);
      }
    });
    await recoveredOpened.page.getByRole('alert').first()
      .waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    await sendImage.click();
    const imageAlert = await recoveredOpened.page.getByRole('alert').first()
      .waitFor({ timeout: 4_000 })
      .then(() => recoveredOpened.page.getByRole('alert').first().innerText())
      .catch(() => null);
    const imageConversation = recoveredOpened.page.locator('[data-conversation-content]');
    const imageId = await copiedSessionId(recoveredOpened.page);
    checkImageIdentity(imageId);
    const imageLog = sessionLog(join(home, 'sessions'), imageId);
    try {
      await imageConversation.getByText(answer, { exact: false }).first()
        .waitFor({ timeout: 30_000 });
    } catch (error) {
      const events = readEvents(imageLog);
      const bodyText = await recoveredOpened.page.locator('body')
        .innerText({ timeout: 1_000 }).catch(() => '');
      console.error(JSON.stringify({ phase: 'image-response', requestCount: mock.requests.length,
        requestImages: mock.requests.map(request => inlineImages(request.body).length),
        imageHttp,
        eventTypes: events.slice(-8).map(event => event.type),
        lastTurnKind: (events.filter(event => event.type === 'turn/end').at(-1)?.data?.reason as
          { kind?: string } | undefined)?.kind ?? 'none',
        webFailureVisible: bodyText.includes('This turn failed'),
        composerPresent: await imageEditor.count() > 0,
        bodyHasPrompt: bodyText.includes(imagePrompt),
        bodyHasModel: bodyText.includes('DeepSeek-V41-Flash'),
        bodyHasImageName: bodyText.includes(imageName),
        attachmentRetained: await recoveredOpened.page.getByRole('group',
          { name: 'Pending attachments' }).getByRole('img', { name: imageName }).count() > 0,
        alert: imageAlert?.replaceAll(apiKey, '[redacted]').replaceAll(home, '[home]')
          .replaceAll(agents, '[agents]').replaceAll(workspace, '[workspace]')
          .replaceAll(mock.baseURL, '[mock endpoint]').slice(0, 300) ?? null,
        pageErrors: recoveredOpened.errors.length, hostErrors: host.errorCount(),
        hostDiagnostic: host.diagnostic() }));
      throw error;
    }
    const imageMessage = readEvents(imageLog, { strict: true }).find(event =>
      event.type === 'user/message' && JSON.stringify(event.data?.content).includes(imagePrompt));
    const imageContent = imageMessage?.data?.content;
    assert.ok(Array.isArray(imageContent), 'Web image prompt did not persist ordered content');
    const imageBlock = imageContent.find((block: { type?: string }) => block.type === 'image') as
      { attachment?: { attachmentId?: string; mediaType?: string; name?: string; width?: number;
        height?: number }; data?: unknown } | undefined;
    assert.equal(imageBlock?.attachment?.name, imageName);
    assert.equal(imageBlock?.attachment?.mediaType, 'image/png');
    assert.equal(imageBlock?.attachment?.width, 16);
    assert.equal(imageBlock?.attachment?.height, 16);
    assert.ok(imageBlock?.attachment?.attachmentId,
      'image content lacks a durable attachment identity');
    assert.equal(imageBlock?.data, undefined, 'Session V4 image content embeds raw bytes');
    const webImage = imageConversation.getByRole('img', { name: imageName });
    await webImage.waitFor({ timeout: 30_000 });
    assert.equal(await webImage.evaluate(element => (element as HTMLImageElement).naturalWidth), 16,
      'Web could not read the durable image before handoff');
    const webImagePayload = mock.requests.flatMap(request => inlineImages(request.body)).at(-1);
    assert.ok(webImagePayload, 'Web image prompt did not reach the model as an image');

    await browser.close();
    browser = undefined;
    await stopHost(host.child);
    host = undefined;
    await checkImageHandoffInTui(tuiDsh, fixture, home, agents, workspace, imageId,
      mock, apiKey, webImagePayload);
    host = await startHost(dsh, home, agents, workspace, mock.baseURL, apiKey);
    browser = await launchBrowser(browserBin, home);
    const imageOpened = await openPage(browser, host);
    const imageRow = imageOpened.page.locator(`[data-row-key="session:${imageId}"]`);
    await imageRow.waitFor({ timeout: 30_000 });
    await imageRow.click();
    assert.equal(await copiedSessionId(imageOpened.page), imageId,
      'Web reopened the image session under another ID');
    const reopenedImageConversation = imageOpened.page.locator('[data-conversation-content]');
    await reopenedImageConversation.getByText(imageContinuationPrompt, { exact: false }).first()
      .waitFor({ timeout: 30_000 });
    const reopenedImage = reopenedImageConversation.getByRole('img', { name: imageName });
    await reopenedImage.waitFor({ timeout: 30_000 });
    assert.equal(await reopenedImage.evaluate(element => (element as HTMLImageElement).naturalWidth), 16,
      'Web could not read the durable image after TUI continuation');
    pageErrors += imageOpened.errors.length;
    hostErrors += host.errorCount();
    assert.equal(pageErrors, 0, 'browser reported JavaScript errors after image handoff');
    assert.equal(hostErrors, 0, 'DSH Web Host reported errors after image handoff');
    await browser.close();
    browser = undefined;
    await stopHost(host.child);
    host = undefined;

    const v4BeforeLegacy = new Set(sessionLogs(join(home, 'sessions')));
    const legacy = seedLegacyV2Copy(fixture, home, workspace, imageId);
    host = await startHost(dsh, home, agents, workspace, mock.baseURL, apiKey);
    browser = await launchBrowser(browserBin, home);
    const legacyOpened = await openPage(browser, host);
    let legacyListed = await listedSessionIds(legacyOpened.page);
    const listDeadline = Date.now() + 30_000;
    while (!legacyListed.ids.includes(legacy.id) && Date.now() < listDeadline) {
      await legacyOpened.page.waitForTimeout(250);
      legacyListed = await listedSessionIds(legacyOpened.page);
    }
    assert.ok(legacyListed.ids.includes(legacy.id),
      `Copied V2 session is absent from Host session/list: HTTP ${legacyListed.status}, ` +
      `listed=${legacyListed.ids.length}, code=${legacyListed.errorCode ?? 'none'}, ` +
      `hostErrors=${host.errorCount()}, diagnostic=${host.diagnostic()}`);
    const legacyRow = await revealSessionRow(legacyOpened.page, legacy.id);
    await legacyRow.click();
    assert.equal(await copiedSessionId(legacyOpened.page), legacy.id,
      'Web opened the copied legacy session under another ID');
    await legacyOpened.page.locator('[data-conversation-content]')
      .getByText(legacyPrompt, { exact: false }).first().waitFor({ timeout: 30_000 });
    await legacyOpened.page.locator('[data-conversation-content]')
      .getByText(legacyAnswer, { exact: false }).first().waitFor({ timeout: 30_000 });
    assert.ok(readFileSync(legacy.source).equals(legacy.original),
      'Web read changed the copied historical source');
    pageErrors += legacyOpened.errors.length;
    hostErrors += host.errorCount();
    await browser.close();
    browser = undefined;
    await stopHost(host.child);
    host = undefined;

    await continueLegacyV2InTui(tuiDsh, fixture, home, agents, workspace, legacy, mock, apiKey);
    assert.deepEqual(sessionLogs(join(home, 'sessions')).filter(path => !v4BeforeLegacy.has(path)),
      [legacy.current], 'Legacy handoff created another Session V4 archive');
    host = await startHost(dsh, home, agents, workspace, mock.baseURL, apiKey);
    browser = await launchBrowser(browserBin, home);
    const migratedOpened = await openPage(browser, host);
    const migratedRow = await revealSessionRow(migratedOpened.page, legacy.id);
    await migratedRow.click();
    assert.equal(await copiedSessionId(migratedOpened.page), legacy.id,
      'Web reopened the migrated session under another ID');
    const migratedConversation = migratedOpened.page.locator('[data-conversation-content]');
    await migratedConversation.getByText(legacyPrompt, { exact: false }).first()
      .waitFor({ timeout: 30_000 });
    await migratedConversation.getByText(legacyAnswer, { exact: false }).first()
      .waitFor({ timeout: 30_000 });
    await migratedConversation.getByText(legacyContinuationPrompt, { exact: false }).first()
      .waitFor({ timeout: 30_000 });
    pageErrors += migratedOpened.errors.length;
    hostErrors += host.errorCount();

    // A path that disappeared after a settled handoff must not offer a live editor.
    renameSync(otherWorkspace, join(fixture, 'second-workspace-moved'));
    await browser.close();
    browser = undefined;
    await stopHost(host.child);
    host = await startHost(dsh, home, agents, workspace, mock.baseURL, apiKey);
    browser = await launchBrowser(browserBin, home);
    const unavailableOpened = await openPage(browser, host);
    const unavailableList = await listedSessionIds(unavailableOpened.page);
    assert.equal(unavailableList.status, 200);
    assert.equal(unavailableList.locations.find(item => item.sessionId === secondWorkspaceSessionId)?.cwd,
      otherWorkspace, 'Cold Web list lost the original canonical workspace identity');
    const unavailableRow = await revealSessionRow(unavailableOpened.page, secondWorkspaceSessionId);
    assert.equal(existsSync(otherWorkspace), false, 'Moved workspace unexpectedly exists before selection');
    await unavailableRow.click();
    // Wait for the selected session to settle as either read-only history or a
    // Host-reported load error; a brief absence of the editor is only loading.
    const unavailableConversation = unavailableOpened.page.locator('[data-conversation-content]');
    const unavailableOutcome = await Promise.any([
      unavailableConversation.getByText(secondTuiMarkers.prompt, { exact: false }).first()
        .waitFor({ timeout: 30_000 }).then(() => 'history' as const),
      unavailableConversation.getByText(/^Failed to load history:/).first()
        .waitFor({ timeout: 30_000 }).then(() => 'load-error' as const),
    ]);
    assert.equal(existsSync(otherWorkspace), false, 'Web recreated the missing canonical workspace');
    const unavailableEditor = unavailableOpened.page.getByRole('textbox', { name: editorName });
    assert.ok(await unavailableEditor.count() === 0 || !await unavailableEditor.isEnabled(),
      'Web offered an active editor for a session whose workspace no longer exists');
    console.log(JSON.stringify({ event: 'unavailable-workspace', outcome: unavailableOutcome }));
    pageErrors += unavailableOpened.errors.length;
    hostErrors += host.errorCount();
    assert.equal(pageErrors, 0, 'browser reported JavaScript errors after legacy migration');
    assert.equal(hostErrors, 0, 'DSH Web Host reported errors after legacy migration');
    console.log(JSON.stringify({ result: 'pass', profile: installedHome ? 'workbench' : 'standalone', sessions: 8, tuiToWebTitle: true,
      webToTuiContinuation: true, writerContention: true, toolApproval: true,
      toolRejection: true, runningTurn: true, errorResume: true,
      toolResultsAfterRestart: true, restartResume: true, settledHostCrashHandoff: true,
      interruptedHostCrashHandoff: true, imageHandoff: true, copiedLegacyMigration: true,
      crossWorkspaceMapping: true, unavailableWorkspaceGuard: true,
      interactionRequests, errorRequests, recoveryRequests: mock.requests.length, pageErrors, hostErrors }));
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
