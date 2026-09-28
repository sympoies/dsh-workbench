import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WorkbenchContract } from '../src/contract-types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(fileURLToPath(new URL('../compatibility/workbench.json', import.meta.url)), 'utf8')) as WorkbenchContract;
const renderer = fileURLToPath(new URL('../scripts/tui-compat.mjs', import.meta.url));
const profileLock = fileURLToPath(new URL('../compatibility/tui-profile/pnpm-lock.yaml', import.meta.url));

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300_000 });
  assert.equal(result.error, undefined, `${command} could not start`);
  return result;
}

function errorCode(result: ReturnType<typeof run>): string {
  return /\[ERR_PNPM_[A-Z_]+\]/.exec(`${result.stdout}\n${result.stderr}`)?.[0] ??
    `exit ${result.status}`;
}

// A pinned Workbench profile must never update its own TUI. Every installed
// update entry point refuses before a registry lookup, a profile write, or a
// `dsh plugin update` process.
async function assertSelfUpdateRefused(tuiRoot: string, patchedPlugin: string, stage: string): Promise<void> {
  const home = join(stage, 'dsh-home');
  const workspace = join(home, 'profiles', 'workbench', 'pnpm-workspace.yaml');
  mkdirSync(join(home, 'profiles', 'workbench'), { recursive: true });
  writeFileSync(workspace, 'packages: []\n');
  const before = readFileSync(workspace);
  const update = await import(pathToFileURL(join(tuiRoot, 'lib/types/update.js')).href);
  const saved = { fetch: globalThis.fetch, home: process.env.DSH_HOME, path: process.env.PATH };
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(String(input));
    throw new Error('network disabled in the self-update regression');
  }) as typeof fetch;
  process.env.DSH_HOME = home;
  process.env.PATH = join(stage, 'no-executables');
  try {
    assert.equal(await update.checkForTuiUpdate(), undefined);
    assert.equal((await update.updateTui('workbench')).code, 1);
    assert.equal(await update.cliUpdate('workbench'), 1);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.home;
    process.env.PATH = saved.path;
  }
  assert.deepEqual(requests, [], 'self-update must not query a registry');
  assert.deepEqual(readFileSync(workspace), before, 'self-update must not rewrite the pinned profile');
  assert.match(patchedPlugin,
    /onUpdate: profile === undefined \? undefined : \(\) => \{\s*notifyChannel\(t\('update-managed'\), \{ color: 'warning' \}\);\s*\}/,
    'installed /update must report the managed installation instead of updating');
}

test('pinned pnpm rejects the stale TUI graph and installs the reviewed correction', { timeout: 600_000 }, () => {
  const pinnedPnpm = contract.runtime.pnpm;
  const pnpmVersion = run('pnpm', ['--version'], root);
  assert.equal(pnpmVersion.status, 0, errorCode(pnpmVersion));
  assert.equal(pnpmVersion.stdout.trim(), pinnedPnpm);

  const rendered = run(process.execPath, [renderer], root);
  assert.equal(rendered.status, 0);
  const split = rendered.stdout.indexOf('overrides:\n');
  assert.ok(split > 0);

  const stage = mkdtempSync(join(tmpdir(), 'dsh-workbench-tui-graph-'));
  try {
    mkdirSync(join(stage, 'patches'));
    copyFileSync(join(root, contract.components.tui.compatibilityPatch!.path), join(stage, 'patches/tui-rename.patch'));
    writeFileSync(join(stage, 'package.json'), JSON.stringify({
      name: 'dsh-workbench-tui-graph-check', private: true, version: '0.0.0',
      dependencies: {
        [contract.components.dsh.package.name]: contract.components.dsh.package.version,
        [contract.components.tui.package.name]: contract.components.tui.package.version,
      },
    }));
    const installArgs = ['install', '--lockfile-only', '--strict-peer-dependencies',
      '--ignore-scripts', '--reporter', 'append-only'];
    writeFileSync(join(stage, 'pnpm-workspace.yaml'), rendered.stdout.slice(0, split));
    const baseline = run('pnpm', installArgs, stage);
    assert.notEqual(baseline.status, 0, 'the uncorrected graph unexpectedly resolved');
    assert.equal(errorCode(baseline), '[ERR_PNPM_PEER_DEP_ISSUES]');

    writeFileSync(join(stage, 'pnpm-workspace.yaml'), rendered.stdout);
    const corrected = run('pnpm', installArgs, stage);
    assert.equal(corrected.status, 0, errorCode(corrected));
    const frozen = run('pnpm', ['install', '--frozen-lockfile', '--strict-peer-dependencies',
      '--ignore-scripts', '--reporter', 'append-only'], stage);
    assert.equal(frozen.status, 0, errorCode(frozen));

    const lock = readFileSync(join(stage, 'pnpm-lock.yaml'), 'utf8');
    assert.ok(lock.includes(contract.components.tui.compatibilityPatch!.sha256), 'TUI patch digest missing');
    for (const component of [contract.components.dsh, contract.components.tui]) {
      assert.ok(lock.includes(component.package.integrity), `${component.package.name} integrity missing`);
    }
    const packages = lock.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0];
    assert.ok(packages, 'lockfile packages section missing');
    assert.deepEqual([...packages.matchAll(/^  dsh-working-activity@([^:\s]+):/gm)].map(match => match[1]),
      [contract.components.tui.peerOverrides!.workingActivity]);
    assert.deepEqual([...packages.matchAll(/^  react@([^:\s]+):/gm)].map(match => match[1]),
      [contract.components.tui.peerOverrides!.react]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test('reviewed TUI profile lock installs without resolving a new graph', { timeout: 600_000 }, async () => {
  const stage = mkdtempSync(join(tmpdir(), 'dsh-workbench-tui-profile-'));
  try {
    mkdirSync(join(stage, 'patches'));
    copyFileSync(join(root, contract.components.tui.compatibilityPatch!.path), join(stage, 'patches/tui-rename.patch'));
    writeFileSync(join(stage, 'package.json'), JSON.stringify({
      name: 'dsh-profile-dsh-tui',
      private: true,
      dependencies: {
        [contract.components.tui.package.name]: contract.components.tui.package.version,
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', contract.components.tui.package.name],
        },
      },
    }));
    const rendered = run(process.execPath, [renderer], root);
    assert.equal(rendered.status, 0, rendered.stderr);
    writeFileSync(join(stage, 'pnpm-workspace.yaml'), rendered.stdout);
    copyFileSync(profileLock, join(stage, 'pnpm-lock.yaml'));
    const frozen = run('pnpm', ['install', '--frozen-lockfile', '--strict-peer-dependencies',
      '--ignore-scripts', '--reporter', 'append-only'], stage);
    assert.equal(frozen.status, 0, errorCode(frozen));
    const tuiRoot = join(stage, 'node_modules', contract.components.tui.package.name);
    const patchedPlugin = readFileSync(join(tuiRoot, 'lib/types/dsh-adapter/plugin.js'), 'utf8');
    const headlessHostGuard = patchedPlugin.indexOf("if (hostMode === 'headless-host') {");
    const headlessHostReturn = patchedPlugin.indexOf('return;', headlessHostGuard);
    const approvalHandler = patchedPlugin.indexOf("ctx.on('approval/request'");
    assert.ok(headlessHostGuard >= 0 && headlessHostReturn > headlessHostGuard
      && approvalHandler > headlessHostReturn,
    'headless Web hosts must return before registering the global TUI approval handler');
    assert.match(patchedPlugin,
      /ctx\.on\('approval\/request', \(req, next\) => approvalStore\.park\(req\)\.catch\(\(\) => next\(\)\), \{ global: true, prepend: true \}\);/,
      'installed TUI approval handler must receive agent-scoped dispatch before other global listeners');
    const { ApprovalStore } = await import(pathToFileURL(join(tuiRoot, 'lib/types/dsh-adapter/approvals.js')).href);
    const approvalStore = new ApprovalStore({ mode: 'legacy', slices: [] });
    const sharedCallId = 'shared-low-entropy-call-id';
    const request = (agentId: string) => ({
      agent: {
        id: agentId,
        session: { events: [{ type: 'tool/call', data: { callId: sharedCallId, arguments: '{"command":"true"}' } }] },
      },
      callId: sharedCallId,
      toolName: 'bash',
      signal: new AbortController().signal,
    });
    const firstResult = approvalStore.park(request('agent-first'));
    const secondResult = approvalStore.park(request('agent-second'));
    assert.deepEqual(approvalStore.pendingAgentIds(), ['agent-first', 'agent-second']);
    assert.equal(approvalStore.getSnapshot()?.agentId, 'agent-first');
    approvalStore.decide('allowed-once');
    assert.equal(await firstResult, 'allowed-once');
    assert.equal(approvalStore.getSnapshot()?.agentId, 'agent-second');
    approvalStore.decide('rejected');
    assert.equal(await secondResult, 'rejected');
    assert.deepEqual(approvalStore.pendingAgentIds(), []);
    await assertSelfUpdateRefused(tuiRoot, patchedPlugin, stage);
    const metadata = ts.createSourceFile('session-metadata.js', readFileSync(join(tuiRoot,
      'lib/types/dsh-adapter/channel/session-metadata.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const renameDeclarations = new Map<string, ts.Expression>();
    const findRename = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && ['current', 'renameSession'].includes(node.name.text) && node.initializer) {
        renameDeclarations.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, findRename);
    };
    findRename(metadata);
    assert.equal(renameDeclarations.size, 2, 'Published TUI rename action owners missing');
    // Execute only the actual rename carrier and binding guard; unrelated
    // metadata actions require services outside this TUI-only frozen profile.
    const createSessionMetadataActions = new Function('ctx', 'deps',
      `const current = ${renameDeclarations.get('current')!.getText(metadata)};\n`
      + `const renameSession = ${renameDeclarations.get('renameSession')!.getText(metadata)};\n`
      + 'return { renameSession };');
    const chat = ts.createSourceFile('Chat.js', readFileSync(join(tuiRoot,
      'lib/types/screens/Chat.js'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let renameCommand: ts.CaseClause | undefined;
    let recapApply: ts.ArrowFunction | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)
        && node.expression.text === 'rename') renameCommand = node;
      if (ts.isPropertyAssignment(node) && node.name.getText(chat) === 'onApplyTitle'
        && ts.isArrowFunction(node.initializer)) recapApply = node.initializer;
      ts.forEachChild(node, visit);
    };
    visit(chat);
    assert.ok(renameCommand && recapApply, 'Published TUI rename acknowledgement owners missing');
    // Execute the actual installed UI callback bodies without mounting React.
    // This protects their completion and rejection behavior, not just source spelling.
    const commandRename = new Function('channel', 't', 'setHelpOpen', 'rawInput',
      renameCommand.statements.map(statement => statement.getText(chat)).join('\n'));
    const applyRecap = new Function('channel', 't', 'recap', 'setRecap', recapApply.body.getText(chat));
    for (const owner of ['command', 'recap'] as const) {
      for (const outcome of ['pass', 'reject', 'detach'] as const) {
        const session = { id: 'durable-rename-session' };
        const capture = { agent: { session } };
        const visibleTitles: string[] = [];
        const writes: unknown[] = [];
        const notifications: Array<{ key: string; color?: string }> = [];
        let complete!: () => void;
        let rejectWrite!: (error: Error) => void;
        const write = new Promise<void>((resolveWrite, rejectPending) => {
          complete = resolveWrite; rejectWrite = rejectPending;
        });
        let attached = true;
        const actions = createSessionMetadataActions({ get: (name: string) => {
          if (name === 'sessionTitle') return { rename: (_session: unknown, title: string) => ({ title }) };
          if (name === 'sessionProjectionCache') return { write: (value: unknown) => { writes.push(value); return write; } };
        } }, { owner: { current: () => attached },
          binding: { capture: () => capture, isCurrent: () => true },
          setSessionTitle: (title: string) => visibleTitles.push(title), emit: () => {} });
        let titleApplied = false;
        const channel = { renameSession: actions.renameSession,
          notify: (message: { key: string }, options?: { color?: string }) =>
            notifications.push({ key: message.key, color: options?.color }) };
        const translate = (key: string) => ({ key });
        if (owner === 'command') commandRename(channel, translate, () => {}, 'Durable manual title');
        else applyRecap(channel, translate, { title: 'Durable manual title', titleApplied: false },
          (update: (previous: { title: string; titleApplied: boolean }) => { titleApplied: boolean }) => {
            titleApplied = update({ title: 'Durable manual title', titleApplied }).titleApplied;
          });
        await Promise.resolve();
        assert.deepEqual(visibleTitles, [], `${owner} acknowledged before projection durability`);
        assert.equal(notifications.length, 0, `${owner} notified success before projection durability`);
        assert.equal(titleApplied, false);
        assert.deepEqual(writes, [session]);
        if (outcome === 'detach') attached = false;
        if (outcome === 'reject') rejectWrite(new Error('controlled projection write failure')); else complete();
        await new Promise<void>(resolveTick => setImmediate(resolveTick));
        if (outcome !== 'pass') {
          assert.deepEqual(visibleTitles, []);
          assert.equal(titleApplied, false);
          assert.equal(notifications.length, 1);
          assert.equal(notifications[0].color, 'error');
        } else {
          assert.deepEqual(visibleTitles, ['Durable manual title']);
          assert.equal(titleApplied, owner === 'recap');
          assert.equal(notifications[0]?.key, owner === 'command' ? 'rename-done' : 'recap-title-applied-notify');
        }
      }
    }
    const lock = readFileSync(join(stage, 'pnpm-lock.yaml'), 'utf8');
    assert.ok(lock.includes(contract.components.tui.package.integrity), 'TUI integrity missing');
    assert.ok(lock.includes(contract.components.tui.compatibilityPatch!.sha256), 'TUI patch digest missing');
    const packages = lock.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0];
    assert.ok(packages, 'lockfile packages section missing');
    assert.ok(packages.includes(`  dsh-working-activity@${contract.components.tui.peerOverrides!.workingActivity}:`));
    assert.ok(packages.includes(`  react@${contract.components.tui.peerOverrides!.react}:`));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
