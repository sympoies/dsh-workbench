import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLinuxRelease } from '../src/linux-release-builder.ts';
import { extractLinuxReleaseArchive } from '../src/linux-release-archive.ts';
import { verifyLinuxReleaseContents } from '../src/linux-release-content.ts';
import { buildLinuxOciCarrier, verifyLinuxOciCarrier } from '../src/linux-oci-carrier.ts';
import { validateReleasePaths } from '../src/linux-release-paths.ts';

const [action, buildInputFile, outputLayout, outputArchive, receiptFile, extractionRoot] = process.argv.slice(2);
if (!['prepare', 'verify'].includes(action) || !buildInputFile || !outputLayout
  || !outputArchive || !receiptFile || (action === 'verify' && !extractionRoot)
  || (action === 'prepare' && extractionRoot)) {
  throw new Error('usage: release.sh prepare BUILD_INPUT_JSON OCI_LAYOUT OCI_TAR_GZ RECEIPT_JSON | release.sh verify BUILD_INPUT_JSON OCI_LAYOUT OCI_TAR_GZ RECEIPT_JSON NEW_EXTRACTION_ROOT');
}

const input = JSON.parse(readFileSync(buildInputFile, 'utf8'));
validateReleasePaths(action, input,
  { outputLayout, outputArchive, receiptFile, extractionRoot });
if (action === 'prepare') {
  const release = buildLinuxRelease(input);
  const manifest = JSON.parse(readFileSync(join(input.outputRoot, 'release-manifest.json'), 'utf8'));
  if (manifest.releaseVersion !== release.releaseVersion) throw new Error('release builder identity mismatch');
  const carrier = buildLinuxOciCarrier({
    archivePath: input.outputArchive,
    archiveSha256: release.archiveSha256,
    manifestSha256: release.manifestSha256,
    releaseVersion: release.releaseVersion,
    builderSource: { commit: manifest.builderSource.commit, tree: manifest.builderSource.tree },
    outputLayout,
    outputArchive,
  });
  const packet = { schemaVersion: 'dsh-workbench.linux-release-packet.v1', release, carrier };
  writeFileSync(receiptFile, `${JSON.stringify(packet, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify(packet)}\n`);
} else {
  const packet = JSON.parse(readFileSync(receiptFile, 'utf8'));
  if (packet.schemaVersion !== 'dsh-workbench.linux-release-packet.v1') {
    throw new Error('release packet schema is invalid');
  }
  const release = packet.release;
  const carrier = packet.carrier;
  if (release.releaseVersion !== carrier.releaseVersion
    || release.archiveSha256 !== carrier.archiveSha256
    || release.manifestSha256 !== carrier.manifestSha256) {
    throw new Error('release packet identities differ');
  }
  verifyLinuxOciCarrier({
    archivePath: input.outputArchive,
    archiveSha256: release.archiveSha256,
    manifestSha256: release.manifestSha256,
    releaseVersion: release.releaseVersion,
    builderSource: carrier.builderSource,
    outputLayout,
    outputArchive,
  }, carrier);
  const extracted = extractLinuxReleaseArchive(input.outputArchive, release.archiveSha256, extractionRoot);
  const contents = verifyLinuxReleaseContents(extractionRoot, release.manifestSha256,
    input.runtimeKitRepo);
  const manifest = JSON.parse(readFileSync(join(extractionRoot, 'release-manifest.json'), 'utf8'));
  if (manifest.releaseVersion !== release.releaseVersion
    || manifest.builderSource.commit !== carrier.builderSource.commit
    || manifest.builderSource.tree !== carrier.builderSource.tree) {
    throw new Error('release packet source differs from authenticated archive');
  }
  process.stdout.write(`${JSON.stringify({ releaseVersion: release.releaseVersion,
    archiveSha256: release.archiveSha256, carrierArchiveSha256: carrier.carrierArchiveSha256,
    ...extracted, ...contents })}\n`);
}
