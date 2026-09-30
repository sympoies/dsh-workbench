import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { verifyProfileRecord } from '../src/profile-record.ts';
import type { ProfileRecord } from '../src/profile-record.ts';

const args = process.argv.slice(2);
const requireLock = args[0] === '--require-lock';
const profile = requireLock ? args[1] : args[0];
if (args.length !== (requireLock ? 2 : 1) || !profile || !isAbsolute(profile)) {
  throw new Error('usage: node scripts/verify-profile-record.ts [--require-lock] ABSOLUTE_PROFILE');
}
const record = JSON.parse(readFileSync(new URL('../compatibility/linux-artifacts.json', import.meta.url),
  'utf8')) as ProfileRecord;
process.stdout.write(`${JSON.stringify({ ...verifyProfileRecord(profile, record, { requireLock }),
  result: 'pass' })}\n`);
