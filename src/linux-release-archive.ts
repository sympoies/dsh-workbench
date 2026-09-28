import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/;

function textField(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  return field.subarray(0, zero < 0 ? length : zero).toString('utf8');
}

function octalField(header: Buffer, offset: number, length: number): number {
  const text = textField(header, offset, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('release archive has an invalid tar field');
  return Number.parseInt(text, 8);
}

function parseArchivePath(header: Buffer): string {
  const name = textField(header, 0, 100);
  const prefix = textField(header, 345, 155);
  const raw = prefix ? `${prefix}/${name}` : name;
  const prefixed = raw.startsWith('./') ? raw.slice(2) : raw;
  const path = prefixed.endsWith('/') ? prefixed.slice(0, -1) : prefixed;
  if (path === '' && raw === './') return '.';
  if (!path || path.startsWith('/') || path.includes('\\')
    || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('release archive contains an unsafe path');
  }
  return path;
}

/** Authenticate archive bytes before creating any output, then extract only regular ustar entries. */
export function extractLinuxReleaseArchive(archivePath: string, expectedArchiveSha256: string,
  outputRoot: string): { files: number; archiveSha256: string } {
  if (!digest.test(expectedArchiveSha256) || !isAbsolute(archivePath)
    || !isAbsolute(outputRoot) || resolve(outputRoot) !== outputRoot
    || lstatSync(outputRoot, { throwIfNoEntry: false })) {
    throw new Error('release archive inputs or output root are invalid');
  }
  const parent = dirname(outputRoot);
  const parentStat = lstatSync(parent, { throwIfNoEntry: false });
  if (!parentStat?.isDirectory() || parentStat.uid !== process.getuid?.()
    || realpathSync(parent) !== parent || (parentStat.mode & 0o022) !== 0) {
    throw new Error('release archive output parent is not trusted');
  }
  const archiveStat = lstatSync(archivePath, { throwIfNoEntry: false });
  if (!archiveStat?.isFile() || archiveStat.nlink !== 1) {
    throw new Error('release archive is not a regular single-link file');
  }
  const compressed = readFileSync(archivePath);
  if (compressed.length > 512 * 1024 * 1024 || sha256(compressed) !== expectedArchiveSha256) {
    throw new Error('release archive digest mismatch or size limit');
  }
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: 768 * 1024 * 1024 }); }
  catch { throw new Error('release archive cannot be decompressed'); }
  const entries: Array<{ path: string; type: 'file' | 'directory'; mode: number; bytes: Buffer }> = [];
  const paths = new Set<string>();
  let finished = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.subarray(offset).some(byte => byte !== 0)) throw new Error('release archive has trailing entries');
      finished = true;
      break;
    }
    const checksum = octalField(header, 148, 8);
    const checkHeader = Buffer.from(header);
    checkHeader.fill(32, 148, 156);
    if (checkHeader.reduce((sum, byte) => sum + byte, 0) !== checksum) {
      throw new Error('release archive header checksum differs');
    }
    if (textField(header, 257, 6) !== 'ustar') throw new Error('release archive is not ustar');
    const path = parseArchivePath(header);
    const mode = octalField(header, 100, 8);
    const size = octalField(header, 124, 12);
    const type = header[156];
    const directory = type === 53;
    const regular = type === 0 || type === 48;
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if ((!directory && !regular) || (directory && size !== 0)
      || (directory ? path !== '.' && mode !== 0o755 : mode !== 0o644 && mode !== 0o755)
      || (path === '.' && (!directory || mode !== 0o700))
      || (path !== '.' && paths.has(path)) || size > 256 * 1024 * 1024
      || next > tar.length || entries.length >= 16_384) {
      throw new Error('release archive has an unsafe entry');
    }
    if (path !== '.') {
      paths.add(path);
      entries.push({ path, type: directory ? 'directory' : 'file', mode,
        bytes: tar.subarray(offset + 512, offset + 512 + size) });
    }
    offset = next;
  }
  if (!finished || entries.length === 0 || tar.length % 512 !== 0) {
    throw new Error('release archive is truncated or empty');
  }
  const fileCount = entries.filter(entry => entry.type === 'file').length;
  let created = false;
  try {
    mkdirSync(outputRoot, { mode: 0o700 });
    created = true;
    chmodSync(outputRoot, 0o700);
    for (const entry of entries) {
      const target = join(outputRoot, entry.path.split('/').join(sep));
      if (entry.type === 'directory') {
        mkdirSync(target, { recursive: true, mode: 0o755 });
        chmodSync(target, 0o755);
      } else {
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        writeFileSync(target, entry.bytes, { flag: 'wx', mode: entry.mode });
        chmodSync(target, entry.mode);
      }
    }
  } catch (error) {
    if (created) rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
  return { files: fileCount, archiveSha256: expectedArchiveSha256 };
}
