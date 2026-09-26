import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export function installedPackageRoot(profile: string, packageName: string): string {
  const packageParts = packageName.split('/');
  const candidates = [join(profile, 'node_modules', ...packageParts)];
  const virtualStore = join(profile, 'node_modules', '.pnpm');
  if (existsSync(virtualStore)) {
    for (const entry of readdirSync(virtualStore)) {
      candidates.push(join(virtualStore, entry, 'node_modules', ...packageParts));
    }
  }
  const roots = new Set(candidates.filter(candidate => existsSync(join(candidate, 'package.json'))
    && JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')).name === packageName)
    .map(candidate => realpathSync(candidate)));
  assert.equal(roots.size, 1, `${packageName} must have one installed package root`);
  return [...roots][0]!;
}
