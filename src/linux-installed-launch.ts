import { isAbsolute, resolve } from 'node:path';
import { readOwnerEnvironment, readOwnerFile } from './linux-owner-input.ts';

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
};

const [configPath, face, ...args] = process.argv.slice(2);
if (!configPath || !isAbsolute(configPath) || resolve(configPath) !== configPath
  || (face !== 'web' && face !== 'tui')) {
  throw new Error('usage: launch.ts ABSOLUTE_CONFIG_PATH web|tui [args...]');
}
const config = JSON.parse(readOwnerFile(configPath, 'installed launch configuration', true)
  .toString('utf8')) as LaunchConfig;
if (config.schemaVersion !== 'dsh-workbench.linux-launch.v1') {
  throw new Error('installed launch configuration is invalid');
}
const owner = readOwnerEnvironment(config.ownerEnvironmentFile);
const environment: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(environment)) {
  if (key.startsWith('AGENT_SESSION_')
    || ['DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].includes(key)) {
    delete environment[key];
  }
}
Object.assign(environment, owner.config.environment, owner.secrets);
Object.assign(environment, {
  DSH_HOME: config.dshHome,
  CODEX_HOME: config.codexHome,
  CLAUDE_CONFIG_DIR: config.claudeConfigDir,
  XDG_CONFIG_HOME: config.configHome,
  XDG_STATE_HOME: config.stateHome,
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
if (typeof process.execve !== 'function') {
  throw new Error('installed launch requires process replacement');
}
process.execve(process.execPath, [process.execPath, ...command], Object.fromEntries(
  Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)));
throw new Error('installed launch process replacement returned');
