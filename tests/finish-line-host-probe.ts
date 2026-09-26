import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = process.env.VERIFICATION_ROOT;
assert.ok(root, 'VERIFICATION_ROOT must identify an isolated non-repository directory');

const result = spawnSync('agent-hook', ['finish-line', 'open', '--format', 'json'], {
  cwd: root,
  encoding: 'utf8',
  input: JSON.stringify({
    schema_version: 'agent-hook.finish-line.open.v1',
    product: 'dsh',
    session_id: `workbench-host-probe-${randomUUID()}`,
    turn_id: 'turn-1',
    cwd: root,
    attempt_token: randomUUID(),
  }),
});
assert.equal(result.error, undefined, 'agent-hook host probe could not start');
const response = JSON.parse(result.stdout) as {
  schema_version?: string;
  error?: { code?: string };
};
assert.equal(response.schema_version, 'cli.agent-hook.finish-line-open.v1');
if (result.status === 65 && response.error?.code === 'finish-line-not-in-repository') {
  console.log(JSON.stringify({ result: 'pass', platform: process.platform, containment: 'available' }));
} else {
  throw new Error(`Authoritative finish-line host unavailable on ${process.platform}: exit ${result.status}, code ${response.error?.code ?? 'invalid-response'}`);
}
