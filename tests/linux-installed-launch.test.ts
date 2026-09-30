import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const launch = new URL('../src/linux-installed-launch.ts', import.meta.url).pathname;

test('installed Web and TUI launch replace their process and use only private owner credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-installed-launch-'));
  try {
    const ownerPath = join(root, 'owner.json');
    const secretPath = join(root, 'api-key');
    const configPath = join(root, 'launch.json');
    const kitPackage = join(root, 'kit');
    const fakeEntry = join(root, 'entry.mjs');
    writeFileSync(secretPath, 'owner-test-key\n', { mode: 0o600 });
    writeFileSync(fakeEntry, `console.log(JSON.stringify({
      pid: process.pid, args: process.argv.slice(2),
      key: process.env.DEEPSEEK_API_KEY ?? null,
      url: process.env.DEEPSEEK_BASE_URL ?? null,
      agentSession: process.env.AGENT_SESSION_TEST ?? null,
      dshHome: process.env.DSH_HOME ?? null,
      permissionMode: process.env.DSH_PERMISSION_MODE ?? null,
      configHome: process.env.XDG_CONFIG_HOME ?? null,
      stateHome: process.env.XDG_STATE_HOME ?? null,
      codexHome: process.env.CODEX_HOME ?? null,
      claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    }));\n`, { mode: 0o600 });
    mkdirSync(join(kitPackage, 'dist/bin'), { recursive: true });
    copyFileSync(fakeEntry, join(kitPackage, 'dist/bin/dsh-runtime-kit-launch.js'));
    writeFileSync(ownerPath, JSON.stringify({
      schemaVersion: 'dsh-workbench.owner-environment.v1',
      environment: { DEEPSEEK_BASE_URL: 'https://example.invalid/v1' },
      secretFiles: { DEEPSEEK_API_KEY: secretPath },
    }), { mode: 0o600 });
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 'dsh-workbench.linux-launch.v1', ownerEnvironmentFile: ownerPath,
      runtimeRoot: join(root, 'runtime'), kitPackage, dshCli: fakeEntry,
      tuiEntry: fakeEntry, dshHome: join(root, 'dsh-home'),
      codexHome: join(root, 'codex'), claudeConfigDir: join(root, 'claude'),
      configHome: join(root, 'config'), stateHome: join(root, 'state'),
      privateSkillsDir: join(root, 'skills'), agentDocsHome: join(root, 'docs'),
      hookConfig: join(root, 'hook-config'), hookPolicy: join(root, 'hook-policy'),
      agentHookBin: join(root, 'agent-hook'), agentDocsBin: join(root, 'agent-docs'),
      dshDirectBin: join(root, 'dsh-direct'), agentSessionHooks: join(root, 'hooks.json'),
    }), { mode: 0o600 });
    // The installed launch is a full host agent: the owner's machine tools keep their own
    // configuration homes, and DSH runs without its file sandbox unless the caller chooses a mode.
    const machineHomes = { XDG_CONFIG_HOME: join(root, 'machine-config'),
      XDG_STATE_HOME: join(root, 'machine-state'), CODEX_HOME: join(root, 'machine-codex'),
      CLAUDE_CONFIG_DIR: join(root, 'machine-claude') };
    for (const face of ['web', 'tui']) {
      const { DSH_PERMISSION_MODE: _inheritedMode, ...base } = process.env;
      // An unmanaged launch: the test runner may itself run inside a managed pane.
      for (const key of Object.keys(base)) if (key.startsWith('AGENT_SESSION_')) delete base[key];
      const result = spawnSync(process.execPath, [launch, configPath, face, '--dump-config'], {
        env: { ...base, ...machineHomes, DEEPSEEK_API_KEY: 'inherited-key',
          DEEPSEEK_BASE_URL: 'https://inherited.invalid', AGENT_SESSION_TEST: 'outer-agent' },
        encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      assert.equal(observed.pid, result.pid, 'launch left a supervising process');
      assert.equal(observed.key, 'owner-test-key');
      assert.equal(observed.url, 'https://example.invalid/v1');
      assert.equal(observed.agentSession, null);
      assert.equal(observed.dshHome, join(root, 'dsh-home'));
      assert.equal(observed.permissionMode, 'danger-full-access');
      assert.equal(observed.configHome, machineHomes.XDG_CONFIG_HOME);
      assert.equal(observed.stateHome, machineHomes.XDG_STATE_HOME);
      assert.equal(observed.codexHome, machineHomes.CODEX_HOME);
      assert.equal(observed.claudeConfigDir, machineHomes.CLAUDE_CONFIG_DIR);
      assert.equal(observed.args.at(-1), '--dump-config');
      const chosen = spawnSync(process.execPath, [launch, configPath, face, '--dump-config'], {
        env: { ...base, DSH_PERMISSION_MODE: 'workspace-write' }, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(chosen.status, 0, chosen.stderr);
      assert.equal(JSON.parse(chosen.stdout).permissionMode, 'workspace-write');
    }
    for (const face of ['web', 'tui']) {
      for (const args of [['--profile', 'other'], ['--profile=other'],
        ['--profile', 'workbench', '--profile', 'other'],
        ['--patch', '/tmp/overlay.yml'], ['--patch=/tmp/overlay.yml'],
        ['--from-default-profile', 'web'], ['--from-default-profile=web']]) {
        const refused = spawnSync(process.execPath, [launch, configPath, face, ...args], {
          encoding: 'utf8', timeout: 10_000,
        });
        assert.notEqual(refused.status, 0);
        assert.match(refused.stderr, /owns the workbench profile|cannot change the installed graph/);
        assert.equal(refused.stdout, '');
      }
    }
    writeFileSync(secretPath, '\n', { mode: 0o600 });
    const emptySecret = spawnSync(process.execPath, [launch, configPath, 'web'], {
      encoding: 'utf8', timeout: 10_000,
    });
    assert.notEqual(emptySecret.status, 0);
    assert.match(emptySecret.stderr, /owner secret reference is invalid/);
    writeFileSync(secretPath, 'owner-test-key\n', { mode: 0o600 });
    writeFileSync(ownerPath, JSON.stringify({
      schemaVersion: 'dsh-workbench.owner-environment.v1', environment: {}, secretFiles: {},
    }), { mode: 0o600 });
    const absent = spawnSync(process.execPath, [launch, configPath, 'web'], {
      env: { ...process.env, DEEPSEEK_API_KEY: 'inherited-key' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(absent.status, 0, absent.stderr);
    assert.equal(JSON.parse(absent.stdout).key, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const seedUuid = '0f8b2c4e-8d1a-4c3b-9e7f-2a6d5b1c9e04';

/** A private launch fixture with a fake owner launcher, kit history adapter and profile closure. */
function managedFixture(root: string) {
  const ownerPath = join(root, 'owner.json');
  const configPath = join(root, 'launch.json');
  const kitPackage = join(root, 'kit');
  const dshHome = join(root, 'dsh-home');
  const profile = join(dshHome, 'profiles/workbench');
  const fakeEntry = join(root, 'entry.mjs');
  const binDir = join(root, 'nils');
  const agentSessionBin = join(binDir, 'agent-session');
  const hooks = join(root, 'config/agent-session-hooks.json');
  writeFileSync(fakeEntry, `console.log(JSON.stringify({ args: process.argv.slice(2),
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      key.startsWith('AGENT_SESSION_') || key.startsWith('DSH_') || key === 'PATH'
      || key === 'DEEPSEEK_API_KEY')) }));\n`,
  { mode: 0o600 });
  mkdirSync(join(kitPackage, 'dist/bin'), { recursive: true });
  copyFileSync(fakeEntry, join(kitPackage, 'dist/bin/dsh-runtime-kit-launch.js'));
  copyFileSync(fakeEntry, join(kitPackage, 'dist/bin/dsh-runtime-kit-history.js'));
  mkdirSync(binDir);
  for (const name of ['agent-session', 'main-agent']) {
    writeFileSync(join(binDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  }
  mkdirSync(join(root, 'config'));
  writeFileSync(hooks, '{"hooks":{}}\n', { mode: 0o600 });
  // The seed resolves the backend the way the installed profile does: from the
  // profile, through the DSH installation, into the base bundle.
  const scope = (base: string, name: string) => join(base, 'node_modules', ...name.split('/'));
  const dsh = scope(profile, '@deepseek-ai/dsh');
  const base = scope(dsh, '@deepseek-ai/dsh-base');
  const modules: Record<string, [string, string]> = {
    '@deepseek-ai/cordis': [dsh, `export class Context {
      async plugin(Plugin, config) { this.sessionPersistence = new Plugin(config); }
      fiber = { dispose: async () => {} };
    }\n`],
    '@deepseek-ai/dsh-session': [base, 'export const SESSION_FORMAT_VERSION = 4;\n'],
    '@deepseek-ai/dsh-session-persistence-jsonl': [base, `import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
      import { join } from 'node:path';
      export default class JsonlSessionPersistence {
        constructor(config) { this.config = config; }
        async create(header) {
          const dir = join(this.config.root, header.id);
          if (existsSync(dir)) throw new Error('SessionAlreadyExistsError');
          mkdirSync(dir, { recursive: true });
          const path = join(dir, 'header.json');
          return { flush: async () => writeFileSync(path, JSON.stringify({ header, config: this.config })),
            close: async () => {} };
        }
      }\n`],
  };
  for (const [owner, name] of [[profile, '@deepseek-ai/dsh'], [dsh, '@deepseek-ai/dsh-base']] as const) {
    mkdirSync(scope(owner, name), { recursive: true });
    writeFileSync(join(scope(owner, name), 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
  }
  for (const [name, [owner, source]] of Object.entries(modules)) {
    const dir = scope(owner, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module',
      exports: { '.': './index.js', './package.json': './package.json' } }));
    writeFileSync(join(dir, 'index.js'), source);
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-workbench',
    dependencies: { '@deepseek-ai/dsh': 'file:x' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  writeFileSync(ownerPath, JSON.stringify({ schemaVersion: 'dsh-workbench.owner-environment.v1',
    environment: {}, secretFiles: {} }), { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 'dsh-workbench.linux-launch.v1', ownerEnvironmentFile: ownerPath,
    runtimeRoot: join(root, 'runtime'), kitPackage, dshCli: fakeEntry, tuiEntry: fakeEntry, dshHome,
    codexHome: join(root, 'codex'), claudeConfigDir: join(root, 'claude'),
    configHome: join(root, 'config'), stateHome: join(root, 'state'),
    privateSkillsDir: join(root, 'skills'), agentDocsHome: join(root, 'docs'),
    hookConfig: join(root, 'hook-config'), hookPolicy: join(root, 'hook-policy'),
    agentHookBin: join(root, 'agent-hook'), agentDocsBin: join(root, 'agent-docs'),
    dshDirectBin: join(root, 'dsh-direct'), agentSessionHooks: hooks,
  }), { mode: 0o600 });
  const managed = { AGENT_SESSION_ID: 'managed-1', AGENT_SESSION_RUNTIME_ID: 'runtime-1',
    AGENT_SESSION_BIN: agentSessionBin, AGENT_SESSION_TOKEN_FILE: '/fixture/token' };
  const run = (face: string, args: string[], env: NodeJS.ProcessEnv, cwd = root) => {
    const { DSH_TUI_SESSION_ROOT: _root, ...base } = process.env;
    for (const key of Object.keys(base)) if (key.startsWith('AGENT_SESSION_')) delete base[key];
    return spawnSync(process.execPath, [launch, configPath, face, ...args],
      { env: { ...base, ...env }, encoding: 'utf8', timeout: 10_000, cwd });
  };
  return { configPath, dshHome, profile, binDir, agentSessionBin, hooks, managed, run, kitPackage };
}

test('a managed TUI pane keeps its agent-session identity and mounts the activity hooks', () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-managed-launch-'));
  try {
    const { binDir, agentSessionBin, hooks, managed, run } = managedFixture(root);
    const callerHooks = { DSH_WORKBENCH_AGENT_SESSION_HOOKS: '/caller/hooks.json' };
    const tui = run('tui', [], { ...managed, ...callerHooks });
    assert.equal(tui.status, 0, tui.stderr);
    const observed = JSON.parse(tui.stdout).env;
    assert.equal(observed.AGENT_SESSION_ID, 'managed-1');
    assert.equal(observed.AGENT_SESSION_RUNTIME_ID, 'runtime-1');
    assert.equal(observed.AGENT_SESSION_TOKEN_FILE, '/fixture/token');
    assert.equal(observed.DSH_WORKBENCH_AGENT_SESSION_HOOKS, hooks);
    assert.equal(observed.DSH_RUNTIME_KIT_AGENT_SESSION_BIN, agentSessionBin);
    assert.equal(observed.DSH_RUNTIME_KIT_MAIN_AGENT_BIN, join(binDir, 'main-agent'));
    assert.equal(observed.PATH.split(':')[0], binDir, 'hook commands must reach the pane agent-session');
    // The Web face and any launch without a complete managed identity stay unmanaged.
    // A caller-named hooks file never reaches the profile gate: a managed pane gets the
    // owner-installed surface and every other launch gets none.
    for (const [face, env] of [['web', managed],
      ['tui', { ...managed, AGENT_SESSION_RUNTIME_ID: '' }],
      ['tui', { ...managed, AGENT_SESSION_BIN: 'agent-session' }],
      ['tui', { ...managed, AGENT_SESSION_BIN: join(root, 'missing/agent-session') }],
      ['tui', { ...managed, AGENT_SESSION_BIN: join(binDir, 'main-agent') }]] as const) {
      const result = run(face, [], { ...env, ...callerHooks });
      assert.equal(result.status, 0, result.stderr);
      const stripped = JSON.parse(result.stdout).env;
      assert.deepEqual(Object.keys(stripped).filter(key => key.startsWith('AGENT_SESSION_')), []);
      assert.equal(stripped.DSH_WORKBENCH_AGENT_SESSION_HOOKS, undefined);
      assert.equal(stripped.DSH_RUNTIME_KIT_AGENT_SESSION_BIN, undefined);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the seed face creates one empty session for a managed pane that then resumes it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-seed-'));
  try {
    const { dshHome, managed, run } = managedFixture(root);
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const seeded = run('seed', ['--session-id', seedUuid], managed, workspace);
    assert.equal(seeded.status, 0, seeded.stderr);
    assert.deepEqual(JSON.parse(seeded.stdout),
      { schema_version: 'dsh-workbench.seed.v1', provider_session_id: seedUuid });
    const stored = JSON.parse(readFileSync(join(dshHome, 'sessions', seedUuid, 'header.json'), 'utf8'));
    assert.deepEqual(stored.config, { root: join(dshHome, 'sessions'), compression: 'zstd' });
    assert.equal(stored.header.id, seedUuid);
    assert.equal(stored.header.version, 4);
    assert.equal(stored.header.cwd, workspace);
    assert.equal(stored.header.isSeeded, false);
    assert.ok(Number.isSafeInteger(stored.header.createdAt));
    const { projectTuiResume } = await import('../src/launch-workbench.ts');
    assert.equal(projectTuiResume(['--resume', seedUuid], {}).environment.DSH_TUI_RESUME_SESSION, seedUuid);
    const again = run('seed', ['--session-id', seedUuid], managed, workspace);
    assert.notEqual(again.status, 0, 'an existing session must never be reseeded');
    for (const [args, env] of [
      [['--session-id', seedUuid], {}],
      [['--session-id', seedUuid], { ...managed, AGENT_SESSION_ID: '' }],
      [['--session-id', 'not-a-uuid'], managed],
      [['--session-id'], managed],
      [['--session-id', seedUuid, '--resume', seedUuid], managed],
      [[], managed]] as const) {
      const refused = run('seed', [...args], env, workspace);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, env.AGENT_SESSION_ID
        ? /installed seed expects exactly --session-id UUID/
        : /installed seed requires an agent-session managed pane/);
      assert.equal(refused.stdout, '');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the history face runs the bundled adapter against the installed profile unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-history-'));
  try {
    const { dshHome, kitPackage, profile, run } = managedFixture(root);
    const result = run('history', ['list', '--root', join(dshHome, 'sessions'), '--compression', 'zstd',
      '--limit', '5'], { DEEPSEEK_API_KEY: 'inherited-key', DSH_CODEX_SUBSCRIPTION_TOKEN: 'inherited-token',
      DSH_CODEX_PROXY_TOKEN: 'inherited-token', DSH_CODEX_SUBSCRIPTION_URL: 'https://inherited.invalid/v1' });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed.args, ['list', '--profile-root', profile, '--root',
      join(dshHome, 'sessions'), '--compression', 'zstd', '--limit', '5']);
    assert.equal(observed.env.DSH_HOME, dshHome);
    assert.equal(observed.env.DEEPSEEK_API_KEY, undefined, 'the history adapter never receives a model credential');
    for (const name of ['DSH_CODEX_SUBSCRIPTION_TOKEN', 'DSH_CODEX_PROXY_TOKEN', 'DSH_CODEX_SUBSCRIPTION_URL']) {
      assert.equal(observed.env[name], undefined, `the history adapter never receives ${name}`);
    }
    assert.ok(kitPackage);
    for (const args of [['list', '--profile-root', '/elsewhere'], ['list', '--profile-root=/elsewhere'], []]) {
      const refused = run('history', args, {});
      assert.notEqual(refused.status, 0);
      assert.equal(refused.stdout, '');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex route settings reach the installed launch only from the owner environment file', () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-installed-codex-'));
  try {
    const ownerPath = join(root, 'owner.json');
    const configPath = join(root, 'launch.json');
    const kitPackage = join(root, 'kit');
    const fakeEntry = join(root, 'entry.mjs');
    const names = ['DSH_CODEX_SUBSCRIPTION_URL', 'DSH_CODEX_PROXY_URL', 'DSH_WORKBENCH_DEFAULT_PROVIDER',
      'DSH_WORKBENCH_DEFAULT_MODEL', 'DSH_CODEX_SUBSCRIPTION_TOKEN', 'DSH_CODEX_PROXY_TOKEN'];
    writeFileSync(fakeEntry, `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}
      .map(name => [name, process.env[name] ?? null]))));\n`, { mode: 0o600 });
    mkdirSync(join(kitPackage, 'dist/bin'), { recursive: true });
    copyFileSync(fakeEntry, join(kitPackage, 'dist/bin/dsh-runtime-kit-launch.js'));
    writeFileSync(join(root, 'subscription-token'), 'owner-subscription-token\n', { mode: 0o600 });
    writeFileSync(join(root, 'proxy-token'), 'owner-proxy-token\n', { mode: 0o600 });
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 'dsh-workbench.linux-launch.v1', ownerEnvironmentFile: ownerPath,
      runtimeRoot: join(root, 'runtime'), kitPackage, dshCli: fakeEntry,
      tuiEntry: fakeEntry, dshHome: join(root, 'dsh-home'),
      codexHome: join(root, 'codex'), claudeConfigDir: join(root, 'claude'),
      configHome: join(root, 'config'), stateHome: join(root, 'state'),
      privateSkillsDir: join(root, 'skills'), agentDocsHome: join(root, 'docs'),
      hookConfig: join(root, 'hook-config'), hookPolicy: join(root, 'hook-policy'),
      agentHookBin: join(root, 'agent-hook'), agentDocsBin: join(root, 'agent-docs'),
      dshDirectBin: join(root, 'dsh-direct'),
    }), { mode: 0o600 });
    const inherited = Object.fromEntries(names.map(name => [name, `inherited-${name}`]));
    const launchWith = (owner: unknown, face: string) => {
      writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
      return spawnSync(process.execPath, [launch, configPath, face],
        { env: { ...process.env, ...inherited }, encoding: 'utf8', timeout: 10_000 });
    };
    for (const face of ['web', 'tui']) {
      const configured = launchWith({
        schemaVersion: 'dsh-workbench.owner-environment.v1',
        environment: {
          DSH_CODEX_SUBSCRIPTION_URL: 'https://subscription.example.invalid/v1',
          DSH_CODEX_PROXY_URL: 'https://proxy.example.invalid/v1',
          DSH_WORKBENCH_DEFAULT_PROVIDER: 'codex-subscription',
          DSH_WORKBENCH_DEFAULT_MODEL: 'gpt-6.1-sol',
        },
        secretFiles: {
          DSH_CODEX_SUBSCRIPTION_TOKEN: join(root, 'subscription-token'),
          DSH_CODEX_PROXY_TOKEN: join(root, 'proxy-token'),
        },
      }, face);
      assert.equal(configured.status, 0, configured.stderr);
      assert.deepEqual(JSON.parse(configured.stdout), {
        DSH_CODEX_SUBSCRIPTION_URL: 'https://subscription.example.invalid/v1',
        DSH_CODEX_PROXY_URL: 'https://proxy.example.invalid/v1',
        DSH_WORKBENCH_DEFAULT_PROVIDER: 'codex-subscription',
        DSH_WORKBENCH_DEFAULT_MODEL: 'gpt-6.1-sol',
        DSH_CODEX_SUBSCRIPTION_TOKEN: 'owner-subscription-token',
        DSH_CODEX_PROXY_TOKEN: 'owner-proxy-token',
      });
      // An owner who configures nothing gets none of the caller's values either.
      const absent = launchWith({
        schemaVersion: 'dsh-workbench.owner-environment.v1', environment: {}, secretFiles: {},
      }, face);
      assert.equal(absent.status, 0, absent.stderr);
      assert.deepEqual(JSON.parse(absent.stdout), Object.fromEntries(names.map(name => [name, null])));
    }
    const misplaced = launchWith({
      schemaVersion: 'dsh-workbench.owner-environment.v1',
      environment: { DSH_CODEX_SUBSCRIPTION_TOKEN: 'a-token-in-plain-settings' }, secretFiles: {},
    }, 'web');
    assert.notEqual(misplaced.status, 0);
    assert.match(misplaced.stderr, /owner environment contains an unsupported setting/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
