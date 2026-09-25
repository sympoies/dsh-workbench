import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const contract = JSON.parse(readFileSync(new URL('../compatibility/workbench.json', import.meta.url), 'utf8'));
const script = new URL('../scripts/tui-compat.mjs', import.meta.url).pathname;

test('the reviewed TUI peer correction is scoped to one transitive package and current DSH', () => {
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const selector = `dsh-working-activity@${contract.components.tui.peerOverrides.workingActivity}>`;
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], 'minimumReleaseAgeExclude:');
  assert.equal(lines[1], `  - '${contract.components.tui.package.name}@${contract.components.tui.package.version}'`);
  assert.equal(lines[2], 'overrides:');
  assert.equal(lines.length, 13);
  assert.ok(lines.includes(`  '${contract.components.tui.package.name}@${contract.components.tui.package.version}>dsh-working-activity': ${contract.components.tui.peerOverrides.workingActivity}`));
  assert.ok(lines.includes(`  react: ${contract.components.tui.peerOverrides.react}`));
  for (const peer of [
    '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-invariants', '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-system-prompt',
  ]) {
    assert.ok(lines.includes(`  '${selector}${peer}': ${contract.components.dsh.package.version}`), peer);
  }
  assert.ok(lines.includes(`  '${selector}react': ${contract.components.tui.peerOverrides.react}`));
});
