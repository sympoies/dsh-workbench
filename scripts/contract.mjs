#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const defaultPath = fileURLToPath(new URL('../compatibility/workbench.json', import.meta.url));
const sha = /^[a-f0-9]{40}$/;
const integrity = /^sha512-[A-Za-z0-9+/]{86}==$/;
const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const platform = /^(?:linux|darwin)-(?:x64|arm64)$/;
const evidenceUrl = /^https:\/\/github\.com\/(sympoies\/(?:dsh-workbench|dsh-runtime-kit)|ccch1mneyyy\/dsh-TUI)\/(?:pull\/[1-9]\d*|actions\/runs\/[1-9]\d*|commit\/[a-f0-9]{40})(?:#[A-Za-z0-9._-]+)?$/;
const components = ['dsh', 'runtimeKit', 'tui'];
const gates = ['runtimeKit', 'tui', 'web', 'handoff'];

function fail(message) {
  throw new Error(message);
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function string(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a nonempty string`);
  return value;
}

function match(value, regex, name) {
  if (!regex.test(string(value, name))) fail(`${name} has an invalid value`);
}

function exactKeys(value, expected, name) {
  const actual = Object.keys(object(value, name)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) fail(`${name} has missing or unexpected fields`);
}

function read(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('cannot read a valid contract file');
  }
}

function validate(contract) {
  exactKeys(contract, ['schemaVersion', 'release', 'status', 'runtime', 'components', 'acceptance'], 'contract');
  if (contract.schemaVersion !== 1) fail('unsupported contract schemaVersion');
  exactKeys(contract.release, ['version', 'tag'], 'release');
  match(contract.release.version, version, 'release.version');
  if (contract.release.tag !== `v${contract.release.version}`) fail('release.tag must match release.version');
  if (!['candidate', 'accepted'].includes(contract.status)) fail('invalid contract status');
  exactKeys(contract.runtime, ['node', 'platforms'], 'runtime');
  match(contract.runtime.node, /^>=\d+\.\d+\.\d+$/, 'runtime.node');
  if (!Array.isArray(contract.runtime.platforms) || !contract.runtime.platforms.length ||
      new Set(contract.runtime.platforms).size !== contract.runtime.platforms.length ||
      !contract.runtime.platforms.every(value => platform.test(value))) fail('invalid runtime.platforms');
  exactKeys(contract.components, components, 'components');
  for (const id of components) {
    const item = contract.components[id];
    exactKeys(item, ['source', 'package', 'toolchain', 'status'], `components.${id}`);
    exactKeys(item.source, id === 'runtimeKit' ? ['url', 'commit', 'tree'] : ['url', 'tag', 'commit', 'tree'], `${id}.source`);
    match(item.source.url, /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, `${id}.source.url`);
    if (item.source.tag !== undefined) match(item.source.tag, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, `${id}.source.tag`);
    match(item.source.commit, sha, `${id}.source.commit`);
    match(item.source.tree, sha, `${id}.source.tree`);
    exactKeys(item.package, ['name', 'version', 'integrity'], `${id}.package`);
    match(item.package.name, /^@[a-z0-9-]+\/[a-z0-9-]+$/, `${id}.package.name`);
    match(item.package.version, version, `${id}.package.version`);
    if (id === 'dsh' && item.source.tag !== `dsh-v${item.package.version}`) fail('dsh source tag and package version disagree');
    if (id === 'tui' && item.source.tag !== `v${item.package.version}`) fail('tui source tag and package version disagree');
    if (id === 'runtimeKit') {
      if (item.package.integrity !== `git-tree:${item.source.tree}`) fail('runtimeKit package integrity must match its Git tree');
    } else {
      match(item.package.integrity, integrity, `${id}.package.integrity`);
    }
    exactKeys(item.toolchain, id === 'runtimeKit' ? ['node'] : ['node', 'pnpm'], `${id}.toolchain`);
    string(item.toolchain.node, `${id}.toolchain.node`);
    if (item.toolchain.pnpm !== undefined) match(item.toolchain.pnpm, version, `${id}.toolchain.pnpm`);
    if (!['candidate', 'accepted'].includes(item.status)) fail(`invalid ${id}.status`);
  }
  exactKeys(contract.acceptance, gates, 'acceptance');
  const allEvidenceUrls = new Set();
  for (const gate of gates) {
    const item = contract.acceptance[gate];
    exactKeys(item, ['status', 'evidence'], `acceptance.${gate}`);
    if (!['pending', 'passed'].includes(item.status) || !Array.isArray(item.evidence)) fail(`invalid acceptance.${gate}`);
    const gatePlatforms = new Set();
    for (const evidence of item.evidence) {
      exactKeys(evidence, ['platform', 'url'], `acceptance.${gate}.evidence`);
      if (!contract.runtime.platforms.includes(evidence.platform) || !evidenceUrl.test(evidence.url)) fail(`invalid acceptance.${gate} evidence`);
      const owner = evidenceUrl.exec(evidence.url)[1];
      if ((gate === 'web' || gate === 'handoff') && owner !== 'sympoies/dsh-workbench') fail(`invalid acceptance.${gate} evidence owner`);
      if (gate === 'runtimeKit' && owner === 'ccch1mneyyy/dsh-TUI') fail('invalid acceptance.runtimeKit evidence owner');
      if (gate === 'tui' && owner === 'sympoies/dsh-runtime-kit') fail('invalid acceptance.tui evidence owner');
      if (allEvidenceUrls.has(evidence.url)) fail('acceptance evidence links must be distinct');
      allEvidenceUrls.add(evidence.url);
      gatePlatforms.add(evidence.platform);
    }
    if (item.status === 'passed' && contract.runtime.platforms.some(value => !gatePlatforms.has(value))) {
      fail(`acceptance.${gate} lacks evidence for a target platform`);
    }
  }
  if (contract.status === 'accepted' &&
      (components.some(id => contract.components[id].status !== 'accepted') ||
       gates.some(gate => contract.acceptance[gate].status !== 'passed' || !contract.acceptance[gate].evidence.length))) {
    fail('accepted contract requires accepted components and acceptance evidence for every gate');
  }
}

function tuple(contract) {
  return {
    runtime: contract.runtime,
    components: components.map(id => {
      const item = contract.components[id];
      return [item.source.url, item.source.tag ?? '', item.source.commit, item.source.tree,
        item.package.name, item.package.version, item.package.integrity, item.toolchain];
    }),
  };
}

function compareVersions(current, previous) {
  const parse = value => {
    const separator = value.indexOf('-');
    const core = separator < 0 ? value : value.slice(0, separator);
    const prerelease = separator < 0 ? undefined : value.slice(separator + 1);
    return { core: core.split('.').map(Number), prerelease: prerelease?.split('.') };
  };
  const a = parse(current);
  const b = parse(previous);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return Math.sign(a.core[index] - b.core[index]);
  }
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    if (aNumeric && bNumeric && Number(aPart) !== Number(bPart)) return Math.sign(Number(aPart) - Number(bPart));
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (aPart !== bPart) return aPart < bPart ? -1 : 1;
  }
  return 0;
}

function args(argv) {
  const [command, ...rest] = argv;
  if (!['check', 'print', 'require-accepted', 'compare'].includes(command)) fail('usage: contract.mjs <check|print|require-accepted|compare> [--contract PATH] [--previous PATH]');
  const options = { contract: defaultPath };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!['--contract', '--previous'].includes(flag) || !rest[index + 1]) fail('invalid contract option');
    options[flag.slice(2)] = rest[index + 1];
  }
  if (command === 'compare' && !options.previous) fail('compare requires --previous');
  if (command !== 'compare' && options.previous) fail('--previous requires compare');
  return { command, options };
}

try {
  const { command, options } = args(process.argv.slice(2));
  const contract = read(options.contract);
  validate(contract);
  if (command === 'require-accepted' && contract.status !== 'accepted') fail('candidate contract cannot be activated');
  if (command === 'compare') {
    const previous = read(options.previous);
    validate(previous);
    const changed = JSON.stringify(tuple(contract)) !== JSON.stringify(tuple(previous));
    if (changed && contract.release.version === previous.release.version) fail('component tuple changed without a new Workbench release.version');
    if (contract.release.version !== previous.release.version && compareVersions(contract.release.version, previous.release.version) <= 0) {
      fail('new Workbench release.version must advance');
    }
    if (previous.status === 'accepted' &&
        contract.release.version === previous.release.version && JSON.stringify(contract) !== JSON.stringify(previous)) {
      fail('accepted release contract is immutable');
    }
  }
  if (command === 'print') process.stdout.write(`${JSON.stringify(contract)}\n`);
  else process.stdout.write('Contract valid.\n');
} catch (error) {
  process.stderr.write(`Contract check failed: ${error.message}\n`);
  process.exitCode = 1;
}
