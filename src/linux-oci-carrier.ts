import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, readSync, realpathSync, rmSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const shaPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const artifactType = 'application/vnd.sympoies.dsh-workbench.release.v1';
const archiveType = 'application/vnd.sympoies.dsh-workbench.release.v1.tar+gzip';
const emptyConfig = Buffer.from('{}');
const emptyDigest = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

export type LinuxOciCarrierInput = {
  archivePath: string;
  archiveSha256: string;
  manifestSha256: string;
  releaseVersion: string;
  builderSource: { commit: string; tree: string };
  outputLayout: string;
  outputArchive: string;
};

export type LinuxOciCarrierReceipt = {
  schemaVersion: 'dsh-workbench.linux-oci-carrier-receipt.v1';
  releaseVersion: string;
  archiveSha256: string;
  manifestSha256: string;
  builderSource: { commit: string; tree: string };
  manifestDigest: string;
  indexSha256: string;
  carrierArchiveSha256: string;
};

function hash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashFile(path: string, limit = 512 * 1024 * 1024): { digest: string; size: number } {
  const descriptor = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const hasher = createHash('sha256');
  let size = 0;
  try {
    for (;;) {
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > limit) throw new Error('OCI carrier input exceeds size limit');
      hasher.update(chunk.subarray(0, count));
    }
  } finally { closeSync(descriptor); }
  return { digest: hasher.digest('hex'), size };
}

function ownerFile(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
    || realpathSync(path) !== path) throw new Error('OCI carrier input is not a private regular file');
}

function newOutput(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || lstatSync(path, { throwIfNoEntry: false })) {
    throw new Error('OCI carrier output must be a new absolute path');
  }
  const parent = dirname(path);
  const stat = lstatSync(parent, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o022) !== 0 || realpathSync(parent) !== parent) {
    throw new Error('OCI carrier output parent is not trusted');
  }
}

function validate(input: LinuxOciCarrierInput, outputsNew: boolean): { archiveSize: number } {
  if (!shaPattern.test(input.archiveSha256) || !shaPattern.test(input.manifestSha256)
    || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(input.releaseVersion)
    || !commitPattern.test(input.builderSource.commit) || !commitPattern.test(input.builderSource.tree)) {
    throw new Error('OCI carrier release identity is invalid');
  }
  ownerFile(input.archivePath);
  const archive = hashFile(input.archivePath);
  if (archive.digest !== input.archiveSha256) throw new Error('OCI carrier archive digest mismatch');
  if (outputsNew) {
    newOutput(input.outputLayout);
    newOutput(input.outputArchive);
    if (input.outputArchive.startsWith(`${input.outputLayout}/`)
      || input.outputLayout.startsWith(`${input.outputArchive}/`)) {
      throw new Error('OCI carrier outputs cannot contain one another');
    }
  }
  return { archiveSize: archive.size };
}

function manifest(input: LinuxOciCarrierInput, archiveSize: number): Buffer {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    artifactType,
    config: { mediaType: 'application/vnd.oci.empty.v1+json',
      digest: `sha256:${emptyDigest}`, size: 2 },
    layers: [{ mediaType: archiveType, digest: `sha256:${input.archiveSha256}`, size: archiveSize,
      annotations: { 'org.opencontainers.image.title': `dsh-workbench-linux-x64-${input.releaseVersion}.tar.gz` } }],
    annotations: {
      'org.opencontainers.image.title': `dsh-workbench-linux-x64-${input.releaseVersion}`,
      'org.opencontainers.image.version': input.releaseVersion,
      'org.opencontainers.image.source': 'https://github.com/sympoies/dsh-workbench',
      'org.opencontainers.image.revision': input.builderSource.commit,
      'org.sympoies.dsh-workbench.source-tree': input.builderSource.tree,
      'org.sympoies.dsh-workbench.release-manifest-sha256': input.manifestSha256,
      'org.sympoies.dsh-workbench.execution': 'installer-only',
    },
  })}\n`);
}

function index(input: LinuxOciCarrierInput, manifestBytes: Buffer): Buffer {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${hash(manifestBytes)}`, size: manifestBytes.length, artifactType,
      annotations: { 'org.opencontainers.image.ref.name': `v${input.releaseVersion}` } }],
  })}\n`);
}

function pack(layout: string, archive: string): void {
  const run = spawnSync('tar', ['--format=ustar', '--sort=name', '--mtime=@0', '--owner=0',
    '--group=0', '--numeric-owner', '-czf', archive, '-C', layout, '.'], {
    timeout: 120_000, maxBuffer: 1024 * 1024,
  });
  if (run.status !== 0 || run.error) throw new Error('OCI carrier tar assembly failed');
  chmodSync(archive, 0o644);
}

/** Create an OCI artifact carrying one authenticated archive, with no executable image config. */
export function buildLinuxOciCarrier(input: LinuxOciCarrierInput): LinuxOciCarrierReceipt {
  const { archiveSize } = validate(input, true);
  const manifestBytes = manifest(input, archiveSize);
  const indexBytes = index(input, manifestBytes);
  let madeLayout = false;
  try {
    mkdirSync(join(input.outputLayout, 'blobs/sha256'), { recursive: true, mode: 0o755 });
    madeLayout = true;
    const blobs = join(input.outputLayout, 'blobs/sha256');
    copyFileSync(input.archivePath, join(blobs, input.archiveSha256));
    chmodSync(join(blobs, input.archiveSha256), 0o644);
    writeFileSync(join(blobs, emptyDigest), emptyConfig, { flag: 'wx', mode: 0o644 });
    writeFileSync(join(blobs, hash(manifestBytes)), manifestBytes, { flag: 'wx', mode: 0o644 });
    writeFileSync(join(input.outputLayout, 'index.json'), indexBytes, { flag: 'wx', mode: 0o644 });
    writeFileSync(join(input.outputLayout, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n',
      { flag: 'wx', mode: 0o644 });
    pack(input.outputLayout, input.outputArchive);
    const receipt: LinuxOciCarrierReceipt = {
      schemaVersion: 'dsh-workbench.linux-oci-carrier-receipt.v1',
      releaseVersion: input.releaseVersion,
      archiveSha256: input.archiveSha256,
      manifestSha256: input.manifestSha256,
      builderSource: input.builderSource,
      manifestDigest: `sha256:${hash(manifestBytes)}`,
      indexSha256: hash(indexBytes),
      carrierArchiveSha256: hashFile(input.outputArchive).digest,
    };
    verifyLinuxOciCarrier(input, receipt);
    return receipt;
  } catch (error) {
    if (madeLayout) rmSync(input.outputLayout, { recursive: true, force: true });
    if (lstatSync(input.outputArchive, { throwIfNoEntry: false })) rmSync(input.outputArchive);
    throw error;
  }
}

function exactEntries(directory: string, expected: string[]): void {
  const actual = readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error('OCI carrier layout has unexpected entries');
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o022) !== 0 || realpathSync(directory) !== directory) {
    throw new Error('OCI carrier layout directory is unsafe');
  }
}

/** Check the complete OCI layout against trusted external release identities and tar bytes. */
export function verifyLinuxOciCarrier(input: LinuxOciCarrierInput,
  receipt: LinuxOciCarrierReceipt): true {
  const { archiveSize } = validate(input, false);
  const manifestBytes = manifest(input, archiveSize);
  const indexBytes = index(input, manifestBytes);
  if (receipt.schemaVersion !== 'dsh-workbench.linux-oci-carrier-receipt.v1'
    || receipt.releaseVersion !== input.releaseVersion
    || receipt.archiveSha256 !== input.archiveSha256
    || receipt.manifestSha256 !== input.manifestSha256
    || JSON.stringify(receipt.builderSource) !== JSON.stringify(input.builderSource)
    || receipt.manifestDigest !== `sha256:${hash(manifestBytes)}`
    || receipt.indexSha256 !== hash(indexBytes)) {
    throw new Error('OCI carrier receipt identity mismatch');
  }
  const blobs = join(input.outputLayout, 'blobs/sha256');
  exactEntries(input.outputLayout, ['blobs', 'index.json', 'oci-layout']);
  exactEntries(join(input.outputLayout, 'blobs'), ['sha256']);
  exactEntries(blobs, [input.archiveSha256, emptyDigest, hash(manifestBytes)]);
  const files: Array<[string, Buffer | null, string]> = [
    [join(input.outputLayout, 'oci-layout'), Buffer.from('{"imageLayoutVersion":"1.0.0"}\n'), 'layout'],
    [join(input.outputLayout, 'index.json'), indexBytes, 'index'],
    [join(blobs, emptyDigest), emptyConfig, 'config'],
    [join(blobs, hash(manifestBytes)), manifestBytes, 'manifest'],
    [join(blobs, input.archiveSha256), null, 'payload'],
  ];
  for (const [path, expected, name] of files) {
    ownerFile(path);
    const actual = hashFile(path);
    if (actual.digest !== (expected ? hash(expected) : input.archiveSha256)
      || (expected && actual.size !== expected.length)) {
      throw new Error(`OCI carrier ${name} digest mismatch`);
    }
  }
  ownerFile(input.outputArchive);
  if (hashFile(input.outputArchive).digest !== receipt.carrierArchiveSha256) {
    throw new Error('OCI carrier tar digest mismatch');
  }
  const temp = mkdtempSync(join(tmpdir(), 'workbench-oci-verify-'));
  chmodSync(temp, 0o700);
  try {
    const rebuilt = join(temp, 'carrier.tar.gz');
    pack(input.outputLayout, rebuilt);
    if (hashFile(rebuilt).digest !== receipt.carrierArchiveSha256) {
      throw new Error('OCI carrier tar differs from the verified layout');
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
  return true;
}
