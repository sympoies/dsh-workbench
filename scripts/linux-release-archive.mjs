import { extractLinuxReleaseArchive } from '../src/linux-release-archive.ts';
import { verifyLinuxReleaseContents } from '../src/linux-release-content.ts';

const [archive, archiveSha256, manifestSha256, outputRoot, kitRepo] = process.argv.slice(2);
if (process.argv.length !== 7) {
  throw new Error('usage: node scripts/linux-release-archive.mjs ARCHIVE ARCHIVE_SHA256 MANIFEST_SHA256 OUTPUT_ROOT KIT_REPO');
}
const extracted = extractLinuxReleaseArchive(archive, archiveSha256, outputRoot);
const contents = verifyLinuxReleaseContents(outputRoot, manifestSha256, kitRepo);
process.stdout.write(`${JSON.stringify({ ...extracted, ...contents, manifestSha256 })}\n`);
