import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function installedPackageRoot(profile: string, packageName: string): string {
  const packageParts = packageName.split('/');
  const direct = join(profile, 'node_modules', ...packageParts);
  if (existsSync(join(direct, 'package.json'))
    && JSON.parse(readFileSync(join(direct, 'package.json'), 'utf8')).name === packageName) {
    return realpathSync(direct);
  }
  const candidates: string[] = [];
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

export function installedDependencyRoot(profile: string, importerName: string,
  dependencyName: string): string {
  const importer = installedPackageRoot(profile, importerName);
  const resolved = createRequire(join(importer, 'package.json')).resolve(dependencyName);
  let candidate = dirname(resolved);
  while (candidate !== dirname(candidate)) {
    const manifest = join(candidate, 'package.json');
    if (existsSync(manifest)
      && JSON.parse(readFileSync(manifest, 'utf8')).name === dependencyName) {
      return realpathSync(candidate);
    }
    candidate = dirname(candidate);
  }
  throw new Error(`${dependencyName} did not resolve to an installed package root from ${importerName}`);
}
