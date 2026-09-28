import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildLinuxOciCarrier, verifyLinuxOciCarrier } from '../src/linux-oci-carrier.ts';

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workbench-oci-'));
  chmodSync(root, 0o700);
  const archive = join(root, 'release.tar.gz');
  const payload = Buffer.from('authenticated-linux-archive');
  writeFileSync(archive, payload, { mode: 0o600 });
  const input = {
    archivePath: archive,
    archiveSha256: sha256(payload),
    manifestSha256: sha256('release-manifest'),
    releaseVersion: '0.1.0',
    builderSource: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    outputLayout: join(root, 'layout'),
    outputArchive: join(root, 'carrier.tar.gz'),
  };
  return { root, input };
}

test('OCI carrier binds raw archive and release identities without a runnable image config', () => {
  const { root, input } = fixture();
  try {
    const receipt = buildLinuxOciCarrier(input);
    assert.equal(receipt.archiveSha256, input.archiveSha256);
    assert.match(receipt.manifestDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(verifyLinuxOciCarrier(input, receipt), true);
    const manifest = JSON.parse(readFileSync(join(input.outputLayout,
      'blobs/sha256', receipt.manifestDigest.slice(7)), 'utf8'));
    assert.equal(manifest.artifactType, 'application/vnd.sympoies.dsh-workbench.release.v1');
    assert.equal(manifest.config.mediaType, 'application/vnd.oci.empty.v1+json');
    assert.equal(manifest.layers[0].digest, `sha256:${input.archiveSha256}`);
    assert.equal(manifest.annotations['org.sympoies.dsh-workbench.execution'], 'installer-only');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OCI carrier rejects wrong external digest before creating output', () => {
  const { root, input } = fixture();
  try {
    assert.throws(() => buildLinuxOciCarrier({ ...input, archiveSha256: '0'.repeat(64) }), /digest/);
    assert.equal(existsSync(input.outputLayout), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OCI carrier verifier rejects mutated payload and metadata', () => {
  const { root, input } = fixture();
  try {
    const receipt = buildLinuxOciCarrier(input);
    const blob = join(input.outputLayout, 'blobs/sha256', input.archiveSha256);
    writeFileSync(blob, 'wrong payload');
    assert.throws(() => verifyLinuxOciCarrier(input, receipt), /digest|payload/);
    writeFileSync(blob, readFileSync(input.archivePath));
    const manifest = join(input.outputLayout, 'blobs/sha256', receipt.manifestDigest.slice(7));
    writeFileSync(manifest, '{}');
    assert.throws(() => verifyLinuxOciCarrier(input, receipt), /digest|manifest/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OCI carrier verifier binds tar bytes and receipt to the verified layout', () => {
  const { root, input } = fixture();
  try {
    const receipt = buildLinuxOciCarrier(input);
    assert.throws(() => verifyLinuxOciCarrier(input,
      { ...receipt, manifestSha256: '0'.repeat(64) }), /identity/);
    const original = readFileSync(input.outputArchive);
    writeFileSync(input.outputArchive, Buffer.concat([original, Buffer.from('extra')]));
    assert.throws(() => verifyLinuxOciCarrier(input, receipt), /tar digest/);
    const substituted = { ...receipt, carrierArchiveSha256: sha256(readFileSync(input.outputArchive)) };
    assert.throws(() => verifyLinuxOciCarrier(input, substituted), /differs from the verified layout/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OCI carrier refuses replacement of existing outputs', () => {
  const { root, input } = fixture();
  try {
    buildLinuxOciCarrier(input);
    assert.throws(() => buildLinuxOciCarrier(input), /exist|new/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OCI construction and verification ignore an ambient tar executable', () => {
  const { root, input } = fixture();
  const originalPath = process.env.PATH;
  try {
    const shadow = join(root, 'shadow');
    mkdirSync(shadow, { mode: 0o700 });
    const fakeTar = join(shadow, 'tar');
    writeFileSync(fakeTar, '#!/bin/sh\nexit 73\n', { mode: 0o755 });
    process.env.PATH = `${shadow}:${originalPath ?? ''}`;
    const receipt = buildLinuxOciCarrier(input);
    assert.equal(verifyLinuxOciCarrier(input, receipt), true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});
