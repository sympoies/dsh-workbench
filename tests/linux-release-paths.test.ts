import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateReleasePaths } from '../src/linux-release-paths.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workbench-release-paths-'));
  chmodSync(root, 0o700);
  const buildInput = {
    frozenProfile: join(root, 'profile'), runtimeKitRepo: join(root, 'kit'),
    runtimeKitPackage: join(root, 'kit.tgz'), nilsArchive: join(root, 'nils.tgz'),
    profileLicenseInventory: join(root, 'profile-licenses.json'),
    cliLicenseInventory: join(root, 'cli-licenses.json'),
    outputRoot: join(root, 'release-root'), outputArchive: join(root, 'release.tar.gz'),
  };
  const paths = { outputLayout: join(root, 'oci-layout'), outputArchive: join(root, 'oci.tar.gz'),
    receiptFile: join(root, 'packet.json'), extractionRoot: join(root, 'extracted') };
  return { root, buildInput, paths };
}

test('release preparation rejects a receipt nested in the future OCI layout', () => {
  const { root, buildInput, paths } = fixture();
  try {
    assert.throws(() => validateReleasePaths('prepare', buildInput,
      { ...paths, receiptFile: join(paths.outputLayout, 'receipt.json') }), /overlap/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release verification rejects extraction inside an already verified OCI layout', () => {
  const { root, buildInput, paths } = fixture();
  try {
    assert.throws(() => validateReleasePaths('verify', buildInput,
      { ...paths, extractionRoot: join(paths.outputLayout, 'extracted') }), /overlap/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release paths reject an extraction root under any source input', () => {
  const { root, buildInput, paths } = fixture();
  try {
    assert.throws(() => validateReleasePaths('verify', buildInput,
      { ...paths, extractionRoot: join(buildInput.runtimeKitRepo, 'extracted') }), /overlap/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release paths accept separate private siblings and reject existing new outputs', () => {
  const { root, buildInput, paths } = fixture();
  try {
    assert.doesNotThrow(() => validateReleasePaths('prepare', buildInput, paths));
    writeFileSync(paths.receiptFile, '{}');
    assert.throws(() => validateReleasePaths('prepare', buildInput, paths), /exist|new/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
