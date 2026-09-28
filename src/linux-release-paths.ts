import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { LinuxReleaseBuildInput } from './linux-release-builder.ts';

type ReleasePaths = {
  outputLayout: string;
  outputArchive: string;
  receiptFile: string;
  extractionRoot?: string;
};

function contains(parent: string, child: string): boolean {
  return parent === child || child.startsWith(`${parent}${sep}`);
}

function canonical(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error('release path must be absolute and canonical');
  }
}

/** Keep every release output separate from each other and from all immutable inputs. */
export function validateReleasePaths(action: 'prepare' | 'verify',
  input: LinuxReleaseBuildInput, paths: ReleasePaths): void {
  const outputs = [input.outputRoot, input.outputArchive, paths.outputLayout,
    paths.outputArchive, paths.receiptFile,
    ...(action === 'verify' ? [paths.extractionRoot] : [])];
  const sources = [input.frozenProfile, input.runtimeKitRepo, input.runtimeKitPackage,
    input.nilsArchive, input.profileLicenseInventory, input.cliLicenseInventory];
  if (outputs.some(path => !path) || sources.some(path => !path)) {
    throw new Error('release path is missing');
  }
  for (const path of [...outputs, ...sources]) canonical(path!);
  for (let index = 0; index < outputs.length; index++) {
    const output = outputs[index]!;
    for (const other of [...outputs.slice(index + 1), ...sources]) {
      if (contains(output, other!) || contains(other!, output)) {
        throw new Error('release paths overlap');
      }
    }
  }
  const newPaths = action === 'prepare' ? outputs : [paths.extractionRoot!];
  for (const path of newPaths) {
    if (lstatSync(path!, { throwIfNoEntry: false })) {
      throw new Error('release output must be new and not exist');
    }
    const parent = dirname(path!);
    const stat = lstatSync(parent, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.uid !== process.getuid?.()
      || (stat.mode & 0o022) !== 0 || realpathSync(parent) !== parent) {
      throw new Error('release output parent is not trusted');
    }
  }
}
