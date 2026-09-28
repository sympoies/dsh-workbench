import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync,
  readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const environmentKeys = new Set(['DEEPSEEK_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']);
const secretKeys = new Set(['DEEPSEEK_API_KEY']);

export type OwnerEnvironment = {
  schemaVersion: 'dsh-workbench.owner-environment.v1';
  environment: Record<string, string>;
  secretFiles: Record<string, string>;
};

export function assertOwnerDirectory(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} path is not canonical`);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.uid !== process.getuid?.()
    || realpathSync(path) !== path || (stat.mode & 0o022) !== 0) {
    throw new Error(`${label} directory is not owner controlled`);
  }
}

/** Read one verified descriptor, never a pathname reopened after validation. */
export function readOwnerFile(path: string, label: string, privateFile = false): Buffer {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute canonical file`);
  }
  assertOwnerDirectory(dirname(path), label);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1
      || (stat.mode & 0o022) !== 0 || (privateFile && (stat.mode & 0o077) !== 0)
      || realpathSync(path) !== path) {
      throw new Error(`${label} is not an owner-controlled regular file`);
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
      || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error(`${label} changed while being read`);
    }
    return bytes;
  } finally { closeSync(fd); }
}

function exactKeys(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has unexpected fields`);
  }
  return value as Record<string, unknown>;
}

export function readOwnerEnvironment(path: string): {
  config: OwnerEnvironment; rawSha256: string; secrets: Record<string, string>;
} {
  const bytes = readOwnerFile(path, 'owner environment', true);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('owner environment is invalid JSON'); }
  const record = exactKeys(parsed, ['schemaVersion', 'environment', 'secretFiles'], 'owner environment');
  if (record.schemaVersion !== 'dsh-workbench.owner-environment.v1') {
    throw new Error('owner environment has an unsupported schema');
  }
  const environment = record.environment;
  const secretFiles = record.secretFiles;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || !secretFiles || typeof secretFiles !== 'object' || Array.isArray(secretFiles)) {
    throw new Error('owner environment settings are invalid');
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!environmentKeys.has(name) || typeof value !== 'string' || value.length > 4096
      || value.includes('\0')) throw new Error('owner environment contains an unsupported setting');
  }
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(secretFiles)) {
    if (!secretKeys.has(name) || typeof value !== 'string') {
      throw new Error('owner environment contains an unsupported secret reference');
    }
    const secret = readOwnerFile(value, 'owner secret reference', true);
    if (secret.length === 0 || secret.length > 16_384) {
      throw new Error('owner secret reference is not private or bounded');
    }
    const effective = secret.toString('utf8').trimEnd();
    if (!effective || effective.includes('\0')) throw new Error('owner secret reference is invalid');
    secrets[name] = effective;
  }
  return { config: record as OwnerEnvironment, rawSha256: digest(bytes), secrets };
}

/** Bind the complete pnpm package closure, including its sibling JS modules. */
export function ownerPackageTreeSha256(root: string, executable: string): string {
  assertOwnerDirectory(root, 'pnpm package');
  const entry = relative(root, executable);
  if (!entry || entry.startsWith('..') || isAbsolute(entry)) {
    throw new Error('pnpm executable is outside its package root');
  }
  const hash = createHash('sha256');
  const pending = [''];
  let files = 0;
  let total = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const directory = join(root, current);
    assertOwnerDirectory(directory, 'pnpm package');
    for (const name of readdirSync(directory).sort().reverse()) {
      const relativePath = join(current, name);
      const path = join(root, relativePath);
      const stat = lstatSync(path);
      if (stat.isDirectory()) { pending.push(relativePath); continue; }
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1
        || (stat.mode & 0o022) !== 0) throw new Error('pnpm package has an unsafe member');
      const bytes = readOwnerFile(path, 'pnpm package member');
      files++;
      total += bytes.length;
      if (files > 4096 || total > 128 * 1024 * 1024) {
        throw new Error('pnpm package exceeds the bounded tree limit');
      }
      hash.update(relativePath.split('\\').join('/'));
      hash.update('\0');
      hash.update(String(stat.mode & 0o777));
      hash.update('\0');
      hash.update(bytes);
      hash.update('\0');
    }
  }
  if (files === 0) throw new Error('pnpm package is empty');
  readOwnerFile(executable, 'pnpm executable');
  return hash.digest('hex');
}
