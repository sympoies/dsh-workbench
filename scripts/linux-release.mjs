import { readFileSync } from 'node:fs';
import { buildLinuxRelease } from '../src/linux-release-builder.ts';

if (process.argv.length !== 3) {
  throw new Error('usage: node scripts/linux-release.mjs /absolute/private/build-input.json');
}
process.stdout.write(`${JSON.stringify(buildLinuxRelease(JSON.parse(readFileSync(process.argv[2], 'utf8'))))}\n`);
