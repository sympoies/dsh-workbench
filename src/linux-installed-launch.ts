import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ownerSuppliedNames, readOwnerEnvironment, readOwnerFile } from './linux-owner-input.ts';

type LaunchConfig = {
  schemaVersion: 'dsh-workbench.linux-launch.v1';
  ownerEnvironmentFile: string;
  runtimeRoot: string;
  kitPackage: string;
  dshCli: string;
  tuiEntry: string;
  dshHome: string;
  codexHome: string;
  claudeConfigDir: string;
  configHome: string;
  stateHome: string;
  privateSkillsDir: string;
  agentDocsHome: string;
  hookConfig: string;
  hookPolicy: string;
  agentHookBin: string;
  agentDocsBin: string;
  dshDirectBin: string;
  agentSessionHooks: string;
};

type Face = 'web' | 'tui' | 'seed' | 'history';

const [configPath, face, ...args] = process.argv.slice(2) as [string, Face, ...string[]];
if (!configPath || !isAbsolute(configPath) || resolve(configPath) !== configPath
  || !['web', 'tui', 'seed', 'history'].includes(face)) {
  throw new Error('usage: launch.ts ABSOLUTE_CONFIG_PATH web|tui|seed|history [args...]');
}
const config = JSON.parse(readOwnerFile(configPath, 'installed launch configuration', true)
  .toString('utf8')) as LaunchConfig;
if (config.schemaVersion !== 'dsh-workbench.linux-launch.v1') {
  throw new Error('installed launch configuration is invalid');
}
const profileRoot = join(config.dshHome, 'profiles/workbench');

/**
 * The agent-session executable that minted this pane, when the launch is one
 * complete managed pane. Anything less is an ordinary launch and keeps none of
 * the caller's agent-session identity.
 */
function managedAgentSession(environment: NodeJS.ProcessEnv): string | undefined {
  const bin = environment.AGENT_SESSION_BIN;
  if (!environment.AGENT_SESSION_ID || !environment.AGENT_SESSION_RUNTIME_ID
    || !bin || !isAbsolute(bin) || resolve(bin) !== bin || basename(bin) !== 'agent-session') return undefined;
  try {
    if (!statSync(bin).isFile()) return undefined;
    accessSync(bin, constants.X_OK);
  } catch { return undefined; }
  return bin;
}

function exec(command: string[], environment: NodeJS.ProcessEnv): never {
  if (typeof process.execve !== 'function') {
    throw new Error('installed launch requires process replacement');
  }
  process.execve(process.execPath, [process.execPath, ...command], Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)));
  throw new Error('installed launch process replacement returned');
}

/**
 * Resolve a module the way the installed profile reaches it: the profile's own
 * dependencies, then the DSH installation it boots, then its declared bundles.
 * DSH carries its session persistence backend inside the base bundle.
 */
function profileModule(specifier: string): string {
  const manifestPath = join(profileRoot, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dsh?: { profile?: { bundles?: unknown } };
  };
  const attempt = (scope: NodeJS.Require, name: string): string | undefined => {
    try { return scope.resolve(name); } catch { return undefined; }
  };
  const scopes = [createRequire(manifestPath)];
  const installation = attempt(scopes[0]!, '@deepseek-ai/dsh/package.json');
  if (installation !== undefined) scopes.push(createRequire(installation));
  const bundles = manifest.dsh?.profile?.bundles;
  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    if (typeof bundle !== 'string') continue;
    const found = scopes.slice(0, 2).map(scope => attempt(scope, `${bundle}/package.json`))
      .find(path => path !== undefined);
    if (found !== undefined) scopes.push(createRequire(found));
  }
  for (const scope of scopes) {
    const resolved = attempt(scope, specifier);
    if (resolved !== undefined) return pathToFileURL(resolved).href;
  }
  throw new Error(`cannot resolve ${specifier} from the installed workbench profile`);
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Create one empty Session for an exact ID that a fresh managed pane then
 * resumes, through the persistence backend and root the TUI face writes with.
 */
async function seed(): Promise<void> {
  if (managedAgentSession(process.env) === undefined) {
    throw new Error('installed seed requires an agent-session managed pane');
  }
  if (args.length !== 2 || args[0] !== '--session-id' || !SESSION_ID.test(args[1] ?? '')) {
    throw new Error('installed seed expects exactly --session-id UUID');
  }
  const id = args[1]!;
  const [{ Context }, { SESSION_FORMAT_VERSION }, persistence] = await Promise.all([
    import(profileModule('@deepseek-ai/cordis')),
    import(profileModule('@deepseek-ai/dsh-session')),
    import(profileModule('@deepseek-ai/dsh-session-persistence-jsonl')),
  ]);
  const JsonlSessionPersistence = persistence.JsonlSessionPersistence ?? persistence.default;
  const ctx = new Context();
  try {
    // The profile keeps the backend's default Zstandard encoding and the TUI's
    // `DSH_TUI_SESSION_ROOT ?? $DSH_HOME/sessions` root.
    await ctx.plugin(JsonlSessionPersistence, {
      root: process.env.DSH_TUI_SESSION_ROOT ?? join(config.dshHome, 'sessions'), compression: 'zstd' });
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: process.cwd(), isSeeded: false });
    try { await handle.flush(); } finally { await handle.close(); }
  } finally { await ctx.fiber.dispose(); }
  process.stdout.write(`${JSON.stringify({ schema_version: 'dsh-workbench.seed.v1', provider_session_id: id })}\n`);
}

if (face === 'seed') {
  try { await seed(); } catch (error) {
    process.stderr.write(`workbench seed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (face === 'history') {
  // agent-session's history contract passes `<op> --root <root> --compression <c> ...`;
  // the installation only adds the profile whose packages read that store.
  if (args.length === 0 || args.some(value => value === '--profile-root' || value.startsWith('--profile-root='))) {
    throw new Error('installed history owns the workbench profile root');
  }
  const environment: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: config.dshHome };
  // The adapter only reads the session store; it never needs a model route or credential.
  for (const name of ownerSuppliedNames) delete environment[name];
  const [operation, ...rest] = args;
  exec([join(config.kitPackage, 'dist/bin/dsh-runtime-kit-history.js'), operation!,
    '--profile-root', profileRoot, ...rest], environment);
}

const owner = readOwnerEnvironment(config.ownerEnvironmentFile);
const environment: NodeJS.ProcessEnv = { ...process.env };
const agentSession = face === 'tui' ? managedAgentSession(process.env) : undefined;
for (const key of Object.keys(environment)) {
  if ((key.startsWith('AGENT_SESSION_') && agentSession === undefined)
    || ownerSuppliedNames.has(key) || key === 'DSH_WORKBENCH_AGENT_SESSION_HOOKS') {
    delete environment[key];
  }
}
if (agentSession !== undefined) {
  // A managed pane reports its turn lifecycle through the hook bridge, whose
  // commands resolve the pane's own agent-session; runtime-kit's controller
  // CLIs are pinned to that executable and its same-release main-agent sibling.
  const mainAgent = join(dirname(agentSession), 'main-agent');
  Object.assign(environment, {
    DSH_WORKBENCH_AGENT_SESSION_HOOKS: config.agentSessionHooks,
    DSH_RUNTIME_KIT_AGENT_SESSION_BIN: agentSession,
    PATH: [dirname(agentSession), environment.PATH].filter(Boolean).join(':'),
  });
  if (existsSync(mainAgent)) environment.DSH_RUNTIME_KIT_MAIN_AGENT_BIN = mainAgent;
}
Object.assign(environment, owner.config.environment, owner.secrets);
// A native install is a full host agent, like the owner's other agents: it keeps the
// machine's tool configuration homes and runs DSH without its file sandbox unless the
// caller chooses a mode. Isolation belongs to a container, not to this environment.
environment.DSH_PERMISSION_MODE ??= 'danger-full-access';
Object.assign(environment, {
  DSH_HOME: config.dshHome,
  DSH_RUNTIME_KIT_DSH_BIN: config.dshDirectBin,
  DSH_RUNTIME_KIT_AGENT_HOOK_BIN: config.agentHookBin,
  DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG: config.hookConfig,
  DSH_RUNTIME_KIT_AGENT_HOOK_POLICY: config.hookPolicy,
  DSH_RUNTIME_KIT_AGENT_HOOK_STATE_DIR: `${config.stateHome}/agent-hook-dsh`,
  DSH_RUNTIME_KIT_AGENT_DOCS_BIN: config.agentDocsBin,
  DSH_RUNTIME_KIT_AGENT_DOCS_HOME: config.agentDocsHome,
  DSH_RUNTIME_KIT_AGENT_DOCS_STATE_HOME: `${config.stateHome}/agent-docs-dsh`,
  DSH_RUNTIME_KIT_PRIVATE_SKILLS_DIR: config.privateSkillsDir,
});
const launcher = `${config.kitPackage}/dist/bin/dsh-runtime-kit-launch.js`;
const appArgs = [...args];
if (appArgs[0] === '--profile') {
  if (appArgs[1] !== 'workbench') throw new Error('installed launch owns the workbench profile');
  appArgs.splice(0, 2);
}
if (appArgs.some(value => value === '--profile' || value.startsWith('--profile='))) {
  throw new Error('installed launch owns the workbench profile');
}
if (appArgs.some(value => ['--patch', '--from-default-profile'].some(option =>
  value === option || value.startsWith(`${option}=`)))) {
  throw new Error('installed launch arguments cannot change the installed graph');
}
const command = face === 'web'
  ? [launcher, '--runtime-root', config.runtimeRoot, '--', process.execPath,
    config.dshCli, '--profile', 'workbench', ...appArgs]
  : [config.tuiEntry, config.kitPackage, config.runtimeRoot, config.dshCli, '--', ...appArgs];
exec(command, environment);
