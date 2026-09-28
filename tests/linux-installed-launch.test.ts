import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      dshDirectBin: join(root, 'dsh-direct'),
    }), { mode: 0o600 });
    for (const face of ['web', 'tui']) {
      const result = spawnSync(process.execPath, [launch, configPath, face, '--dump-config'], {
        env: { ...process.env, DEEPSEEK_API_KEY: 'inherited-key',
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
      assert.equal(observed.args.at(-1), '--dump-config');
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
