import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const limits = {
  compressedBytes: 128 * 1024 * 1024,
  expandedBytes: 256 * 1024 * 1024,
  entries: 16_384,
  entryBytes: 64 * 1024 * 1024,
};

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]));
  }
  return value;
}

function textField(header: Buffer, offset: number, length: number): string {
  const zero = header.indexOf(0, offset);
  const end = zero >= offset && zero < offset + length ? zero : offset + length;
  return header.subarray(offset, end).toString('utf8');
}

function octalField(header: Buffer, offset: number, length: number): number {
  const value = textField(header, offset, length).trim().replace(/^0+/u, '');
  if (value === '') return 0;
  if (!/^[0-7]+$/u.test(value)) throw new Error('invalid peer archive');
  return Number.parseInt(value, 8);
}

type PeerEntry = { path: string; mode: number; bytes: Buffer };

function parsePeerArtifact(tarball: Buffer): {
  entries: PeerEntry[]; manifest: { name?: unknown; version?: unknown };
} {
  if (tarball.length > limits.compressedBytes) throw new Error('peer archive exceeds limit');
  let archive: Buffer;
  try {
    archive = gunzipSync(tarball, { maxOutputLength: limits.expandedBytes });
  } catch {
    throw new Error('invalid peer archive');
  }
  const entries: PeerEntry[] = [];
  const paths = new Set<string>();
  let contentBytes = 0;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = textField(header, 0, 100);
    const prefix = textField(header, 345, 155);
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const mode = octalField(header, 100, 8);
    const size = octalField(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const contentOffset = offset + 512;
    const nextOffset = contentOffset + Math.ceil(size / 512) * 512;
    if (entries.length >= limits.entries || size > limits.entryBytes
      || contentBytes + size > limits.expandedBytes || nextOffset > archive.length
      || (type !== '0' && type !== '\0') || !path.startsWith('package/')
      || path.includes('/../') || paths.has(path)) {
      throw new Error('invalid peer archive');
    }
    paths.add(path);
    contentBytes += size;
    entries.push({ path, mode, bytes: archive.subarray(contentOffset, contentOffset + size) });
    offset = nextOffset;
  }
  const packageJson = entries.find(entry => entry.path === 'package/package.json');
  if (!packageJson || entries.length === 0) throw new Error('peer archive has no manifest');
  let manifest: { name?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(packageJson.bytes.toString('utf8'));
  } catch {
    throw new Error('invalid peer archive manifest');
  }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('invalid peer archive identity');
  }
  return { entries, manifest };
}

/** Verify the canonical package digest defined by the pinned runtime-kit contract. */
export function inspectPeerArtifact(tarball: Buffer): {
  name: string; version: string; artifactSha256: string;
} {
  const { entries, manifest } = parsePeerArtifact(tarball);
  const digest = createHash('sha256');
  for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path))) {
    const bytes = entry.path === 'package/package.json'
      ? Buffer.from(`${JSON.stringify(canonicalJson(manifest))}\n`)
      : entry.bytes;
    digest.update(entry.path);
    digest.update('\0');
    digest.update(String(entry.mode));
    digest.update('\0');
    digest.update(String(bytes.length));
    digest.update('\0');
    digest.update(bytes);
  }
  return { name: manifest.name as string, version: manifest.version as string,
    artifactSha256: digest.digest('hex') };
}

function tarField(header: Buffer, offset: number, width: number, value: number): void {
  const octal = value.toString(8);
  if (octal.length > width - 1) throw new Error('normalized peer archive exceeds ustar field');
  header.write(`${octal.padStart(width - 1, '0')}\0`, offset, width, 'ascii');
}

function stableEntry(entry: PeerEntry): Buffer {
  // Package manifests can contain order-sensitive conditional exports.
  // Repack archive metadata, but never rewrite an authenticated member payload.
  const bytes = entry.bytes;
  const header = Buffer.alloc(512);
  const pathBytes = Buffer.byteLength(entry.path);
  if (pathBytes <= 100) header.write(entry.path, 0, 'utf8');
  else {
    const split = entry.path.lastIndexOf('/');
    const prefix = entry.path.slice(0, split);
    const name = entry.path.slice(split + 1);
    if (split < 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100) {
      throw new Error('normalized peer path exceeds ustar limit');
    }
    header.write(name, 0, 'utf8');
    header.write(prefix, 345, 'utf8');
  }
  if (entry.mode !== 0o644 && entry.mode !== 0o755) {
    throw new Error('normalized peer archive has unsupported mode');
  }
  tarField(header, 100, 8, entry.mode);
  tarField(header, 108, 8, 0);
  tarField(header, 116, 8, 0);
  tarField(header, 124, 12, bytes.length);
  tarField(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0'), 148, 'ascii');
  header[154] = 0;
  header[155] = 32;
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

/** Repack authenticated workspace content into stable bytes for a frozen lockfile. */
export function normalizePeerArtifact(tarball: Buffer): Buffer {
  const { entries } = parsePeerArtifact(tarball);
  const tar = Buffer.concat([...entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map(stableEntry), Buffer.alloc(1024)]);
  const normalized = gzipSync(tar, { level: 0 });
  const before = inspectPeerArtifact(tarball);
  const after = inspectPeerArtifact(normalized);
  if (before.name !== after.name || before.version !== after.version
    || before.artifactSha256 !== after.artifactSha256) {
    throw new Error('normalized peer archive changed canonical content');
  }
  return normalized;
}
