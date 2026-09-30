import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyProfileRecord } from '../src/profile-record.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

test('a staged profile must match the reviewed workspace and lock digests', () => {
  const profile = mkdtempSync(join(tmpdir(), 'workbench-profile-record-'));
  try {
    const workspace = "overrides:\n  '@deepseek-ai/cordis': 'file:artifacts/deepseek-ai-cordis-4.0.4.tgz'\n";
    const lock = "lockfileVersion: '9.0'\n";
    const record = { profileWorkspaceRawSha256: sha(workspace), profileLockRawSha256: sha(lock) };
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), workspace);

    // Before the frozen install the lock is absent; only the workspace is bound.
    assert.deepEqual(verifyProfileRecord(profile, record), { workspace: true, lock: false });
    assert.throws(() => verifyProfileRecord(profile, record, { requireLock: true }),
      /staged profile lock is missing/);

    writeFileSync(join(profile, 'pnpm-lock.yaml'), lock);
    assert.deepEqual(verifyProfileRecord(profile, record, { requireLock: true }),
      { workspace: true, lock: true });

    // pnpm adds a release-age exclusion to the workspace when a locked package
    // is younger than the policy; that edit must not reach the reviewed record.
    writeFileSync(join(profile, 'pnpm-workspace.yaml'),
      `minimumReleaseAgeExclude:\n  - '@deepseek-ai/example@0.2.0-rc.2'\n${workspace}`);
    assert.throws(() => verifyProfileRecord(profile, record),
      /staged profile workspace differs from the reviewed artifact record/);

    writeFileSync(join(profile, 'pnpm-workspace.yaml'), workspace);
    writeFileSync(join(profile, 'pnpm-lock.yaml'), `${lock}# drift\n`);
    assert.throws(() => verifyProfileRecord(profile, record),
      /staged profile lock differs from the reviewed artifact record/);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
