import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ProfileRecord = { profileWorkspaceRawSha256: string; profileLockRawSha256: string };

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Bind a staged profile's pnpm workspace and lock to the reviewed Linux artifact
 * record. The release builder enforces the same digests; checking them on the
 * staged profile catches a workspace that pnpm edited during installation.
 */
export function verifyProfileRecord(profile: string, record: ProfileRecord,
  { requireLock = false }: { requireLock?: boolean } = {}): { workspace: true; lock: boolean } {
  if (sha256(join(profile, 'pnpm-workspace.yaml')) !== record.profileWorkspaceRawSha256) {
    throw new Error('staged profile workspace differs from the reviewed artifact record');
  }
  const lockPath = join(profile, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) {
    if (requireLock) throw new Error('staged profile lock is missing');
    return { workspace: true, lock: false };
  }
  if (sha256(lockPath) !== record.profileLockRawSha256) {
    throw new Error('staged profile lock differs from the reviewed artifact record');
  }
  return { workspace: true, lock: true };
}
