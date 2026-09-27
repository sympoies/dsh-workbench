import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(repo, 'compatibility/workbench.json'), 'utf8')).components.dsh.package.version;
test('combined runtime owner refuses an invalid installed CLI before creating profile state', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'workbench-installed-cli-'));
  try {
    const home = join(fixture, 'new-home');
    for (const cli of ['relative-cli', join(fixture, 'missing-cli'), fixture]) {
      const result = spawnSync(process.execPath, [join(repo, 'scripts/verify-combined-runtime.ts'),
        fixture, fixture, home, join(fixture, 'runtime'), fixture, fixture, cli],
        { cwd: repo, encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.status, 64);
      assert.match(result.stderr, /WORKBENCH_INSTALLED_CLI_INVALID/);
      assert.equal(existsSync(home), false);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
for (const invalid of ['outside-profile', 'package-name', 'package-version']) {
  test(`combined runtime owner refuses installed CLI ${invalid} before creating verification state`, () => {
    const fixture = mkdtempSync(join(tmpdir(), 'workbench-installed-binding-'));
    try {
      const home = join(fixture, 'home');
      const profile = join(home, 'profiles', 'workbench');
      const packageRoot = join(profile, 'node_modules', '@deepseek-ai', 'dsh');
      mkdirSync(join(packageRoot, 'lib'), { recursive: true });
      writeFileSync(join(profile, 'package.json'), JSON.stringify({
        name: 'dsh-profile-workbench',
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
          '@deepseek-harness-tui/dsh-tui'] } },
      }));
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: invalid === 'package-name' ? '@example/other-cli' : '@deepseek-ai/dsh',
        version: invalid === 'package-version' ? '0.0.0' : version,
      }));
      const started = join(fixture, 'started');
      const source = 'import { writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(started)}, 'started');\n`;
      const installedCli = join(packageRoot, 'lib', 'bin.js');
      writeFileSync(installedCli, source);
      const outsideCli = join(fixture, 'other-cli.mjs');
      writeFileSync(outsideCli, source);
      const cli = invalid === 'outside-profile' ? outsideCli : installedCli;
      const result = spawnSync(process.execPath, [join(repo, 'scripts/verify-combined-runtime.ts'),
        fixture, fixture, home, join(fixture, 'runtime'), fixture, fixture, cli],
        { cwd: repo, encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 64, 'Unbound installed CLI must be refused at the argument boundary');
      assert.match(result.stderr, /WORKBENCH_INSTALLED_CLI_INVALID/);
      assert.equal(existsSync(join(fixture, 'workbench-verification')), false);
      assert.equal(existsSync(started), false, 'Unbound CLI must never execute');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}
for (const driver of ['tui-terminal-acceptance.ts', 'web-browser-acceptance.ts']) {
for (const invalid of ['marker', 'environment-home']) {
  test(`installed ${driver} rejects invalid ${invalid} before launching DSH`, () => {
    const fixture = mkdtempSync(join(tmpdir(), 'workbench-target-'));
    try {
      const home = join(fixture, 'home');
      const other = join(fixture, 'other-home');
      mkdirSync(home); mkdirSync(other);
      writeFileSync(join(home, '.workbench-terminal-acceptance'),
        invalid === 'marker' ? '' : 'disposable CI profile\n');
      const environment = join(fixture, 'runtime.json');
      writeFileSync(environment, JSON.stringify({ DSH_HOME: invalid === 'environment-home' ? other : home }));
      const started = join(fixture, 'started');
      const binary = join(fixture, 'dsh.mjs');
      writeFileSync(binary, '#!/usr/bin/env node\n' +
        'import { writeFileSync } from "node:fs";\n' +
        `writeFileSync(${JSON.stringify(started)}, 'started');\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o700 });
      const result = spawnSync(process.execPath, [join('tests', driver),
        '--dsh-bin', binary, '--installed-dsh-home', home, '--runtime-env-file', environment],
        { cwd: repo, encoding: 'utf8', timeout: 20_000 });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, 'Invalid target unexpectedly passed acceptance');
      assert.equal(existsSync(started), false, 'Invalid target launched DSH before refusing');
      assert.equal(existsSync(join(other, 'sessions')), false);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
}
}
