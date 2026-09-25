import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

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

/** Verify the canonical package digest defined by the pinned runtime-kit contract. */
export function inspectPeerArtifact(tarball: Buffer): {
  name: string; version: string; artifactSha256: string;
} {
  if (tarball.length > limits.compressedBytes) throw new Error('peer archive exceeds limit');
  let archive: Buffer;
  try {
    archive = gunzipSync(tarball, { maxOutputLength: limits.expandedBytes });
  } catch {
    throw new Error('invalid peer archive');
  }
  const entries: Array<{ path: string; mode: number; bytes: Buffer }> = [];
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
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('invalid peer archive identity');
  }
  return { name: manifest.name, version: manifest.version, artifactSha256: digest.digest('hex') };
}
