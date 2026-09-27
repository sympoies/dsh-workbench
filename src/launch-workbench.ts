import { isAbsolute, join } from 'node:path';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Project the TUI's explicit resume flag into its existing configuration seam. */
export function projectTuiResume(args: readonly string[], environment: NodeJS.ProcessEnv):
  { args: string[]; environment: NodeJS.ProcessEnv } {
  const forwarded: string[] = [];
  let session: string | undefined;
  let literal = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') {
      literal = true;
      forwarded.push(argument);
      continue;
    }
    if (argument === '-c' || argument === '--continue') {
      throw new Error('WORKBENCH_RESUME_INVALID: this entry requires an explicit exact session ID');
    }
    if (argument !== '--resume' && !argument.startsWith('--resume=')) {
      forwarded.push(argument);
      continue;
    }
    const value = argument === '--resume' ? args[++index] : argument.slice('--resume='.length);
    if (literal || session !== undefined || !value?.trim() || value.startsWith('--')) {
      throw new Error('WORKBENCH_RESUME_INVALID: provide one nonempty session ID');
    }
    session = value;
  }
  const projected = { ...environment };
  delete projected.DSH_TUI_RESUME_SESSION;
  if (session !== undefined) projected.DSH_TUI_RESUME_SESSION = session;
  return { args: forwarded, environment: projected };
}

/** Install the self-contained TUI entry before runtime-kit snapshots the profile. */
export function materializeTuiEntry(directory: string, releaseVersion: string): void {
  if (!isAbsolute(directory)) throw new Error('WORKBENCH_TUI_INSTALL_TARGET_INVALID');
  const files = ['src/launch-workbench.ts', 'scripts/launch-workbench-tui.ts', 'LICENSE'].map(path => {
    const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
    return { path, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, 'src')); mkdirSync(join(directory, 'scripts'));
  for (const file of files) writeFileSync(join(directory, file.path), file.bytes, { flag: 'wx' });
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify({
    schemaVersion: 'dsh-workbench.installed-tui-entry.v1', releaseVersion,
    entry: 'scripts/launch-workbench-tui.ts',
    files: files.map(({ path, sha256 }) => ({ path, sha256 })),
  }, null, 2) + '\n', { flag: 'wx' });
}

/** Replace this process with the unchanged runtime owner and exact installed CLI. */
export function launchWorkbenchTui(argv: string[]): never {
  const [kitPackage, runtimeRoot, dshCli, separator, ...args] = argv;
  if (separator !== '--' || [kitPackage, runtimeRoot, dshCli].some(path => !path || !isAbsolute(path))) {
    throw new Error('WORKBENCH_LAUNCH_ARGUMENT_INVALID: provide absolute kit, runtime and CLI paths followed by --');
  }
  const launcher = join(kitPackage, 'dist/bin/dsh-runtime-kit-launch.js');
  try {
    if (!statSync(launcher).isFile() || !statSync(dshCli).isFile()
      || !statSync(runtimeRoot).isDirectory()) throw new Error();
  } catch {
    throw new Error('WORKBENCH_LAUNCH_TARGET_INVALID: installed owner inputs are unavailable');
  }
  if (typeof process.execve !== 'function') {
    throw new Error('WORKBENCH_EXEC_UNSUPPORTED: this Node runtime cannot replace the launcher process');
  }
  const appArgs = [...args];
  if (appArgs[0] === '--profile') {
    if (appArgs[1] !== 'workbench') throw new Error('WORKBENCH_PROFILE_INVALID: this entry owns the workbench profile');
    appArgs.splice(0, 2);
  }
  if (appArgs.some(value => value === '--profile' || value.startsWith('--profile='))) {
    throw new Error('WORKBENCH_PROFILE_INVALID: this entry owns the workbench profile');
  }
  const projected = projectTuiResume(appArgs, process.env);
  const environment = Object.fromEntries(Object.entries(projected.environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  process.execve(process.execPath, [process.execPath, launcher, '--runtime-root', runtimeRoot,
    '--', process.execPath, dshCli, '--profile', 'workbench', ...projected.args], environment);
  throw new Error('WORKBENCH_EXEC_FAILED: process replacement returned');
}
