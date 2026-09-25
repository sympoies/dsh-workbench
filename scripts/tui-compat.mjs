#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const contractPath = fileURLToPath(new URL('../compatibility/workbench.json', import.meta.url));
const check = spawnSync(process.execPath, [fileURLToPath(new URL('./contract.mjs', import.meta.url)), 'check'], {
  encoding: 'utf8',
});
if (check.status !== 0) {
  process.stderr.write(check.stderr);
  process.exit(check.status ?? 1);
}

const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const { workingActivity, react } = contract.components.tui.peerOverrides;
const dsh = contract.components.dsh.package.version;
const tui = contract.components.tui.package;
const selector = `dsh-working-activity@${workingActivity}>`;
const peers = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
];

// pnpm overrides rewrite only the stale peer edges of this exact dependency.
// The installed package bytes and all other peer declarations remain intact.
const lines = ['minimumReleaseAgeExclude:', `  - '${tui.name}@${tui.version}'`, 'overrides:',
  `  '${tui.name}@${tui.version}>dsh-working-activity': ${workingActivity}`,
  `  react: ${react}`,
  ...peers.map(peer => `  '${selector}${peer}': ${dsh}`),
  `  '${selector}react': ${react}`];
process.stdout.write(`${lines.join('\n')}\n`);
