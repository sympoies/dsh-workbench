import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { inspectSemanticPeerArtifact } from '../src/package-artifact.ts';

const profile = process.argv[2];
if (process.argv.length !== 3 || !profile || !isAbsolute(profile)) {
  throw new Error('usage: node scripts/verify-staged-semantic-peers.ts ABSOLUTE_PROFILE');
}
const record = JSON.parse(readFileSync(new URL('../compatibility/linux-artifacts.json', import.meta.url),
  'utf8')) as { releaseVersion: string; webSemanticSha256: string;
  peerSemanticArtifacts: Array<{ name: string; version: string; semanticSha256: string }> };
const rows = [...record.peerSemanticArtifacts, {
  name: '@sympoies/dsh-workbench-web', version: record.releaseVersion,
  semanticSha256: record.webSemanticSha256,
}];
let drift = 0;
for (const row of rows) {
  const file = join(profile, 'artifacts', `${row.name.slice(1).replace('/', '-')}-${row.version}.tgz`);
  const actual = inspectSemanticPeerArtifact(readFileSync(file));
  if (actual === row.semanticSha256) continue;
  const result = spawnSync('tar', ['-xOzf', file, 'package/package.json'],
    { maxBuffer: 1024 * 1024, timeout: 10_000 });
  if (result.status !== 0) throw new Error(`cannot inspect package manifest: ${row.name}`);
  const manifest = JSON.parse(result.stdout.toString('utf8')) as Record<string, unknown>;
  const fieldDigests = Object.fromEntries(Object.entries(manifest)
    .filter(([, value]) => value !== null && typeof value === 'object')
    .map(([name, value]) => [name, createHash('sha256').update(JSON.stringify(value)).digest('hex')]));
  process.stderr.write(`${JSON.stringify({ name: row.name, expected: row.semanticSha256,
    actual, fieldDigests })}\n`);
  drift++;
}
if (drift > 0) throw new Error(`${drift} staged peer semantic identities differ from reviewed source`);
process.stdout.write(`${JSON.stringify({ peers: record.peerSemanticArtifacts.length,
  web: true, result: 'pass' })}\n`);
