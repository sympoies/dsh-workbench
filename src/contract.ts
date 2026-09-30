import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { WorkbenchContract } from './contract-types.ts';

const defaultPath = fileURLToPath(new URL('../compatibility/workbench.json', import.meta.url));
const sha = /^[a-f0-9]{40}$/;
const integrity = /^sha512-[A-Za-z0-9+/]{86}==$/;
const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const platform = /^(?:linux|darwin)-(?:x64|arm64)$/;
const evidenceUrl = /^https:\/\/github\.com\/(sympoies\/(?:dsh-workbench|dsh-runtime-kit)|ccch1mneyyy\/dsh-TUI)\/(?:pull\/[1-9]\d*|actions\/runs\/[1-9]\d*|commit\/[a-f0-9]{40})(?:#[A-Za-z0-9._-]+)?$/;
const components = ['dsh', 'runtimeKit', 'tui', 'codexSubscription'] as const;
// Schema 4 adds the Codex subscription provider; earlier schemas are read only as a previous contract.
const componentsOf = (contract: WorkbenchContract) =>
  contract.schemaVersion >= 4 ? components : components.filter(id => id !== 'codexSubscription');
const gates = ['runtimeKit', 'tui', 'web', 'handoff'] as const;

function fail(message: string): never {
  throw new Error(message);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a nonempty string`);
  return value;
}

function match(value: unknown, regex: RegExp, name: string): void {
  if (!regex.test(string(value, name))) fail(`${name} has an invalid value`);
}

function exactKeys(value: unknown, expected: readonly string[], name: string): void {
  const actual = Object.keys(object(value, name)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) fail(`${name} has missing or unexpected fields`);
}

function read(path: string): WorkbenchContract {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WorkbenchContract;
  } catch {
    fail('cannot read a valid contract file');
  }
}

function readWebArtifact(contractPath: string, contract: WorkbenchContract, optional = false): string | null {
  const path = join(dirname(contractPath), 'web-artifact.json');
  if (!existsSync(path)) {
    if (optional) return null;
    fail('Web artifact record cannot be read');
  }
  let record: Record<string, unknown>;
  try {
    record = object(JSON.parse(readFileSync(path, 'utf8')), 'Web artifact record');
  } catch {
    fail('Web artifact record cannot be read');
  }
  exactKeys(record, ['schemaVersion', 'releaseVersion', 'name', 'artifactSha256'], 'Web artifact record');
  if (record.schemaVersion !== 'dsh-workbench.web-artifact.v1'
    || record.releaseVersion !== contract.release.version
    || record.name !== '@sympoies/dsh-workbench-web') {
    fail('Web artifact record does not match Workbench contract');
  }
  match(record.artifactSha256, /^[a-f0-9]{64}$/, 'Web artifact digest');
  return record.artifactSha256 as string;
}

function readLinuxArtifacts(contractPath: string, contract: WorkbenchContract): Record<string, unknown> | null {
  const path = join(dirname(contractPath), 'linux-artifacts.json');
  if (!existsSync(path)) return null;
  let record: Record<string, unknown>;
  try { record = object(JSON.parse(readFileSync(path, 'utf8')), 'Linux artifact record'); }
  catch { fail('Linux artifact record cannot be read'); }
  exactKeys(record, ['schemaVersion', 'releaseVersion', 'runtimeKitPackageCanonicalSha256',
    'profileWorkspaceRawSha256', 'profileLockRawSha256', 'webSemanticSha256',
    'peerSemanticArtifacts'], 'Linux artifact record');
  if (record.schemaVersion !== 'dsh-workbench.linux-artifacts.v2'
    || record.releaseVersion !== contract.release.version
    || !['runtimeKitPackageCanonicalSha256', 'profileWorkspaceRawSha256', 'profileLockRawSha256',
      'webSemanticSha256']
      .every(key => typeof record[key] === 'string' && /^[a-f0-9]{64}$/.test(record[key] as string))
    || !Array.isArray(record.peerSemanticArtifacts) || record.peerSemanticArtifacts.length === 0) {
    fail('Linux artifact record does not match Workbench contract');
  }
  const names: string[] = [];
  for (const row of record.peerSemanticArtifacts) {
    exactKeys(row, ['name', 'version', 'semanticSha256'], 'Linux peer semantic identity');
    names.push(string(row.name, 'Linux peer name'));
    string(row.version, 'Linux peer version');
    match(row.semanticSha256, /^[a-f0-9]{64}$/, 'Linux peer semantic digest');
  }
  if (JSON.stringify(names) !== JSON.stringify([...new Set(names)].sort())) {
    fail('Linux peer semantic identities must be sorted and unique');
  }
  return record;
}

function nodeFloor(value: unknown, name: string): number[] {
  const found = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(string(value, name));
  if (!found) fail(`${name} must be a minimum Node version`);
  return found.slice(1).map(Number);
}

function validate(contract: WorkbenchContract, contractPath: string, { previous = false }: { previous?: boolean } = {}): void {
  exactKeys(contract, ['schemaVersion', 'release', 'status', 'runtime', 'components', 'acceptance'], 'contract');
  if (contract.schemaVersion !== 4 && !(previous && [1, 2, 3].includes(contract.schemaVersion))) fail('unsupported contract schemaVersion');
  const legacy = contract.schemaVersion === 1;
  const patched = contract.schemaVersion >= 3;
  exactKeys(contract.release, ['version', 'tag'], 'release');
  match(contract.release.version, version, 'release.version');
  if (contract.release.tag !== `v${contract.release.version}`) fail('release.tag must match release.version');
  if (!['candidate', 'accepted'].includes(contract.status)) fail('invalid contract status');
  exactKeys(contract.runtime, legacy ? ['node', 'platforms'] : ['node', 'pnpm', 'platforms'], 'runtime');
  const runtimeNodeFloor = nodeFloor(contract.runtime.node, 'runtime.node');
  if (!legacy) match(contract.runtime.pnpm, version, 'runtime.pnpm');
  if (!Array.isArray(contract.runtime.platforms) || !contract.runtime.platforms.length ||
      new Set(contract.runtime.platforms).size !== contract.runtime.platforms.length ||
      !contract.runtime.platforms.every((value: string) => platform.test(value))) fail('invalid runtime.platforms');
  exactKeys(contract.components, componentsOf(contract), 'components');
  for (const id of componentsOf(contract)) {
    const item = contract.components[id];
    exactKeys(item, id === 'tui' && patched ? ['source', 'package', 'toolchain', 'peerOverrides', 'compatibilityPatch', 'status'] :
      id === 'tui' && !legacy ? ['source', 'package', 'toolchain', 'peerOverrides', 'status'] :
      ['source', 'package', 'toolchain', 'status'], `components.${id}`);
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
    if (id === 'codexSubscription') {
      if (item.package.name !== '@sympoies/dsh-llm-codex-subscription') fail('codexSubscription package name is not the reviewed provider');
      if (item.source.tag !== `dsh-llm-codex-subscription-v${item.package.version}`) fail('codexSubscription source tag and package version disagree');
    }
    if (id === 'runtimeKit') {
      if (item.package.integrity !== `git-tree:${item.source.tree}`) fail('runtimeKit package integrity must match its Git tree');
    } else {
      match(item.package.integrity, integrity, `${id}.package.integrity`);
    }
    exactKeys(item.toolchain, id === 'runtimeKit' || id === 'codexSubscription' ? ['node'] : ['node', 'pnpm'], `${id}.toolchain`);
    string(item.toolchain.node, `${id}.toolchain.node`);
    if (item.toolchain.pnpm !== undefined) match(item.toolchain.pnpm, version, `${id}.toolchain.pnpm`);
    if (id === 'tui' && !legacy) {
      exactKeys(item.peerOverrides, ['workingActivity', 'react'], 'tui.peerOverrides');
      match(item.peerOverrides?.workingActivity, version, 'tui.peerOverrides.workingActivity');
      match(item.peerOverrides?.react, version, 'tui.peerOverrides.react');
      if (patched) {
        exactKeys(item.compatibilityPatch, ['path', 'sha256'], 'tui.compatibilityPatch');
        if (item.compatibilityPatch?.path !== 'compatibility/patches/tui-rename.patch') fail('invalid tui.compatibilityPatch.path');
        match(item.compatibilityPatch.sha256, /^[a-f0-9]{64}$/, 'tui.compatibilityPatch.sha256');
        let bytes: Buffer;
        try {
          bytes = readFileSync(join(dirname(contractPath), 'patches/tui-rename.patch'));
        } catch {
          fail('tui compatibility patch cannot be read');
        }
        if (createHash('sha256').update(bytes).digest('hex') !== item.compatibilityPatch.sha256) {
          fail('tui compatibility patch digest mismatch');
        }
      }
    }
    if (!['candidate', 'accepted'].includes(item.status)) fail(`invalid ${id}.status`);
  }
  const kitNodeFloor = nodeFloor(contract.components.runtimeKit.toolchain.node, 'runtimeKit.toolchain.node');
  for (let index = 0; index < 3; index++) {
    if (runtimeNodeFloor[index] > kitNodeFloor[index]) break;
    if (runtimeNodeFloor[index] < kitNodeFloor[index]) fail('runtime.node must meet runtimeKit.toolchain.node');
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
      const owner = evidenceUrl.exec(evidence.url)![1];
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
      (componentsOf(contract).some(id => contract.components[id].status !== 'accepted') ||
       gates.some(gate => contract.acceptance[gate].status !== 'passed' || !contract.acceptance[gate].evidence.length))) {
    fail('accepted contract requires accepted components and acceptance evidence for every gate');
  }
}

function tuple(contract: WorkbenchContract, webArtifactDigest: string | null) {
  return {
    runtime: contract.runtime,
    webArtifactDigest,
    components: componentsOf(contract).map(id => {
      const item = contract.components[id];
      return [item.source.url, item.source.tag ?? '', item.source.commit, item.source.tree,
        item.package.name, item.package.version, item.package.integrity, item.toolchain,
        item.peerOverrides ?? null, item.compatibilityPatch ?? null];
    }),
  };
}

function compareVersions(current: string, previous: string): number {
  const parse = (value: string) => {
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

function args(argv: string[]) {
  const [command, ...rest] = argv;
  if (!['check', 'print', 'require-accepted', 'compare'].includes(command)) fail('usage: contract.mjs <check|print|require-accepted|compare> [--contract PATH] [--previous PATH]');
  const options: { contract: string; previous?: string } = { contract: defaultPath };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!['--contract', '--previous'].includes(flag) || !rest[index + 1]) fail('invalid contract option');
    if (flag === '--contract') options.contract = rest[index + 1];
    else options.previous = rest[index + 1];
  }
  if (command === 'compare' && !options.previous) fail('compare requires --previous');
  if (command !== 'compare' && options.previous) fail('--previous requires compare');
  return { command, options };
}

try {
  const { command, options } = args(process.argv.slice(2));
  const contract = read(options.contract);
  validate(contract, options.contract);
  const webArtifactDigest = readWebArtifact(options.contract, contract);
  const linuxArtifacts = readLinuxArtifacts(options.contract, contract);
  if (command === 'require-accepted' && contract.status !== 'accepted') fail('candidate contract cannot be activated');
  if (command === 'compare') {
    const previous = read(options.previous!);
    validate(previous, options.previous!, { previous: true });
    const previousWebArtifactDigest = readWebArtifact(options.previous!, previous, true);
    const previousLinuxArtifacts = readLinuxArtifacts(options.previous!, previous);
    const changed = JSON.stringify(tuple(contract, webArtifactDigest)) !==
      JSON.stringify(tuple(previous, previousWebArtifactDigest))
      || (previousLinuxArtifacts !== null
        && JSON.stringify(linuxArtifacts) !== JSON.stringify(previousLinuxArtifacts));
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
  process.stderr.write(`Contract check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
