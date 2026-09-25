import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkbenchContract } from './contract-types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const contract = JSON.parse(readFileSync(join(root, 'compatibility/workbench.json'), 'utf8')) as WorkbenchContract;
const git = '/usr/bin/git';

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) delete environment[key];
  }
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = '/dev/null';
  environment.GIT_OPTIONAL_LOCKS = '0';
  return environment;
}

/** Read Git bytes without replacement refs, ambient Git config, or object overrides. */
function readGit(args: string[], cwd: string, gitExecutable = git): string {
  if (!isAbsolute(cwd)) throw new Error('Git checkout path must be absolute');
  const result = spawnSync(gitExecutable, args, {
    cwd, env: gitEnvironment(), encoding: 'utf8', timeout: 30_000,
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error('pinned Git object or checkout state is unavailable');
  }
  return result.stdout;
}

/** Resolve only the runtime-kit commit and tree pinned by Workbench. */
export function readPinnedKitJson(kitRepo: string, file: 'compatibility/dsh.json', gitExecutable = git): unknown {
  const pin = contract.components.runtimeKit.source;
  const tree = readGit(['rev-parse', `${pin.commit}^{tree}`], kitRepo, gitExecutable).trim();
  if (tree !== pin.tree) throw new Error('runtime-kit Git tree does not match Workbench contract');
  return JSON.parse(readGit(['show', `${pin.commit}:${file}`], kitRepo, gitExecutable));
}
