import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { WorkbenchContract } from '../src/contract-types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(fileURLToPath(new URL('../compatibility/workbench.json', import.meta.url)), 'utf8')) as WorkbenchContract;
const script = fileURLToPath(new URL('../scripts/tui-compat.mjs', import.meta.url));

test('the reviewed TUI peer correction is scoped to one transitive package and current DSH', () => {
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const selector = `dsh-working-activity@${contract.components.tui.peerOverrides!.workingActivity}>`;
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], 'minimumReleaseAgeExclude:');
  assert.equal(lines[1], `  - '${contract.components.tui.package.name}@${contract.components.tui.package.version}'`);
  assert.equal(lines[2], 'overrides:');
  assert.equal(lines.length, 13);
  assert.ok(lines.includes(`  '${contract.components.tui.package.name}@${contract.components.tui.package.version}>dsh-working-activity': ${contract.components.tui.peerOverrides!.workingActivity}`));
  assert.ok(lines.includes(`  react: ${contract.components.tui.peerOverrides!.react}`));
  for (const peer of [
    '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-invariants', '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-system-prompt',
  ]) {
    assert.ok(lines.includes(`  '${selector}${peer}': ${contract.components.dsh.package.version}`), peer);
  }
  assert.ok(lines.includes(`  '${selector}react': ${contract.components.tui.peerOverrides!.react}`));
});

test('the renderer resolves contract files under a path containing spaces', () => {
  const stage = mkdtempSync(join(tmpdir(), 'dsh workbench '));
  try {
    mkdirSync(join(stage, 'scripts'));
    mkdirSync(join(stage, 'src'));
    mkdirSync(join(stage, 'compatibility'));
    for (const name of ['contract.mjs', 'tui-compat.mjs']) {
      copyFileSync(join(root, 'scripts', name), join(stage, 'scripts', name));
    }
    for (const name of ['contract.ts', 'contract-types.ts', 'tui-compat.ts']) {
      copyFileSync(join(root, 'src', name), join(stage, 'src', name));
    }
    copyFileSync(join(root, 'compatibility', 'workbench.json'),
      join(stage, 'compatibility', 'workbench.json'));
    const result = spawnSync(process.execPath, [join(stage, 'scripts', 'tui-compat.mjs')],
      { cwd: stage, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^minimumReleaseAgeExclude:/);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
