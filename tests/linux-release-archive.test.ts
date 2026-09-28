import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { extractLinuxReleaseArchive } from '../src/linux-release-archive.ts';

function archive(withLink = false) {
  const parent = mkdtempSync(join(tmpdir(), 'dsh-workbench-archive-'));
  chmodSync(parent, 0o700);
  const input = join(parent, 'input');
  mkdirSync(input, { mode: 0o700 });
  writeFileSync(join(input, 'release-manifest.json'), '{}\n', { mode: 0o644 });
  if (withLink) symlinkSync('release-manifest.json', join(input, 'link'));
  const file = join(parent, 'candidate.tar.gz');
  const packed = spawnSync('tar', ['--format=ustar', '-czf', file, '-C', input, '.']);
  assert.equal(packed.status, 0);
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  return { parent, file, sha256, output: join(parent, 'extracted') };
}

function rewriteArchive(fixture: ReturnType<typeof archive>, rewrite: (tar: Buffer) => Buffer): string {
  const tar = rewrite(gunzipSync(readFileSync(fixture.file)));
  writeFileSync(fixture.file, gzipSync(tar));
  return createHash('sha256').update(readFileSync(fixture.file)).digest('hex');
}

function setTarName(header: Buffer, name: string): void {
  header.fill(0, 0, 100);
  header.write(name, 0, 'utf8');
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0'), 148, 'ascii');
  header[154] = 0;
  header[155] = 32;
}

test('authenticated ustar archive extracts only indexed regular bytes into a private root', () => {
  const fixture = archive();
  try {
    assert.equal(extractLinuxReleaseArchive(fixture.file, fixture.sha256, fixture.output).files, 1);
    assert.equal(readFileSync(join(fixture.output, 'release-manifest.json'), 'utf8'), '{}\n');
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

test('archive extraction rejects wrong external digest before creating output', () => {
  const fixture = archive();
  try {
    assert.throws(() => extractLinuxReleaseArchive(fixture.file, '0'.repeat(64), fixture.output),
      /digest mismatch/);
    assert.equal(existsSync(fixture.output), false);
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

test('archive extraction rejects symbolic links even under a matching archive digest', () => {
  const fixture = archive(true);
  try {
    assert.throws(() => extractLinuxReleaseArchive(fixture.file, fixture.sha256, fixture.output),
      /unsafe entry/);
    assert.equal(existsSync(fixture.output), false);
  } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
});

for (const [name, rewrite, error] of [
  ['parent traversal', (tar: Buffer) => {
    const changed = Buffer.from(tar);
    setTarName(changed.subarray(512, 1024), '../escape');
    return changed;
  }, /unsafe path/],
  ['duplicate file', (tar: Buffer) => Buffer.concat([
    tar.subarray(0, 1536), tar.subarray(512, 1536), tar.subarray(1536),
  ]), /unsafe entry/],
  ['invalid header checksum', (tar: Buffer) => {
    const changed = Buffer.from(tar);
    changed[512] ^= 1;
    return changed;
  }, /checksum differs/],
  ['nonzero trailing data', (tar: Buffer) => {
    const changed = Buffer.from(tar);
    changed[2048 + 512] = 1;
    return changed;
  }, /trailing entries/],
  ['truncated entry', (tar: Buffer) => tar.subarray(0, 1537), /truncated or empty|unsafe entry/],
] as const) {
  test(`archive extraction rejects ${name} before creating output`, () => {
    const fixture = archive();
    try {
      const digest = rewriteArchive(fixture, rewrite);
      assert.throws(() => extractLinuxReleaseArchive(fixture.file, digest, fixture.output), error);
      assert.equal(existsSync(fixture.output), false);
    } finally { rmSync(fixture.parent, { recursive: true, force: true }); }
  });
}
