import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, copyFileSync, lstatSync, mkdtempSync, readFileSync,
  rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceDraftRelease, assertAuditComment, assertImmutableReleaseSetting,
  ensureSignedReleaseTag,
  assertPublicationIdentity, type ReleaseRecord } from './linux-publication.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const canonicalRemote = 'https://github.com/sympoies/dsh-workbench.git';
export async function publishLinuxRelease(args: string[]): Promise<void> {
  const [action, buildInputFile, layout, ociArchive, packetFile, extractionRoot,
    notesFile, auditUrl] = args;
  if (!['preflight', 'publish'].includes(action)
    || [buildInputFile, layout, ociArchive, packetFile, extractionRoot, notesFile]
      .some(path => !path || resolve(path) !== path)
    || (action === 'publish' && !auditUrl)
    || (action === 'preflight' && auditUrl)) {
    throw new Error('usage: release.sh preflight BUILD_INPUT OCI_LAYOUT OCI_TAR RECEIPT NEW_EXTRACTION_ROOT NOTES | release.sh publish BUILD_INPUT OCI_LAYOUT OCI_TAR RECEIPT NEW_EXTRACTION_ROOT NOTES ISSUE_8_AUDIT_COMMENT_URL');
  }

  function command(executable: string, args: string[], maxBuffer = 2_000_000,
    timeout = 300_000): string {
    const result = spawnSync(executable, args, { cwd: repo, encoding: 'utf8',
      timeout, maxBuffer });
    if (result.error || result.status !== 0) {
      throw new Error(`${basename(executable)} ${args[0] ?? ''} failed with status ${result.status ?? 'unknown'}`);
    }
    return result.stdout.trim();
  }

  async function sha256(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  }

  function json(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }
  function git(args: string[]): string { return command('/usr/bin/git', args); }
  function gh(args: string[]): string { return command('/usr/bin/gh', args[0] === 'api' ? args :
    [...args, '-R', 'sympoies/dsh-workbench'], 2_000_000,
  args[0] === 'release' && ['create', 'upload'].includes(args[1] ?? '') ? 1_800_000 : 300_000); }
  function releaseAt(tag: string): any | null {
    const result = spawnSync('/usr/bin/gh', ['api',
      `repos/sympoies/dsh-workbench/releases/tags/${tag}`],
    { cwd: repo, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000 });
    if (result.status === 0) return JSON.parse(result.stdout);
    if (result.status === 1 && /HTTP 404/.test(result.stderr)) return null;
    throw new Error('GitHub release lookup failed');
  }

  const packet = json(packetFile);
  const input = json(buildInputFile);
  const source = {
    commit: git(['rev-parse', 'HEAD']),
    tree: git(['rev-parse', 'HEAD^{tree}']),
    branch: git(['branch', '--show-current']),
    clean: git(['status', '--porcelain', '--untracked-files=all']) === '',
    remoteMain: JSON.parse(gh(['api', 'repos/sympoies/dsh-workbench/branches/main'])).commit.sha,
  };
  const assets = { archiveSha256: await sha256(input.outputArchive),
    carrierArchiveSha256: await sha256(ociArchive) };
  assertPublicationIdentity(packet, source, assets);
  assertImmutableReleaseSetting(JSON.parse(gh(['api',
    'repos/sympoies/dsh-workbench/immutable-releases'])));
  if (basename(input.outputArchive) !== 'dsh-workbench-linux-x64-0.1.0.tar.gz'
    || basename(ociArchive) !== 'dsh-workbench-linux-x64-0.1.0.oci.tar.gz') {
    throw new Error('publication asset names are not canonical');
  }
  if (!lstatSync(notesFile).isFile() || !readFileSync(notesFile, 'utf8').includes('DSH Workbench 0.1.0')) {
    throw new Error('release notes do not identify Workbench 0.1.0');
  }
  command('/usr/bin/bash', [join(repo, 'scripts/check-publication.sh'), '--artifact', notesFile]);
  const notesBytes = readFileSync(notesFile);
  const notesSha256 = createHash('sha256').update(notesBytes).digest('hex');
  const verified = JSON.parse(command(process.execPath,
    [join(repo, 'scripts/release.mjs'), 'verify', buildInputFile, layout,
      ociArchive, packetFile, extractionRoot], 8_000_000));
  if (verified.archiveSha256 !== assets.archiveSha256
    || verified.carrierArchiveSha256 !== assets.carrierArchiveSha256) {
    throw new Error('verified release differs from publication packet');
  }

  if (action === 'preflight') {
    process.stdout.write(`${JSON.stringify({ action, tag: 'v0.1.0', source: source.commit,
      archiveSha256: assets.archiveSha256,
      manifestSha256: packet.release.manifestSha256,
      ociManifestDigest: packet.carrier.manifestDigest,
      carrierArchiveSha256: assets.carrierArchiveSha256,
      notesSha256, result: 'verified' })}\n`);
    return;
  }

  const match = /^https:\/\/github\.com\/sympoies\/dsh-workbench\/issues\/8#issuecomment-(\d+)$/.exec(auditUrl);
  if (!match) throw new Error('publication audit URL must identify an issue #8 comment');
  const audit = JSON.parse(gh(['api', `repos/sympoies/dsh-workbench/issues/comments/${match[1]}`]));
  assertAuditComment(packet, { body: audit.body, authorAssociation: audit.author_association }, notesSha256);
  if (audit.html_url !== auditUrl) throw new Error('publication audit comment identity differs');

  const tag = 'v0.1.0';
  const remoteTag = git(['ls-remote', '--tags', canonicalRemote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const tagObject = ensureSignedReleaseTag(tag, source.commit, remoteTag, {
    localExists: () => git(['tag', '--list', tag]) !== '',
    fetchExactRemote: () => { git(['fetch', canonicalRemote,
      `refs/tags/${tag}:refs/tags/${tag}`]); },
    createSigned: () => { git(['tag', '-s', tag, '-m',
      `DSH Workbench ${packet.release.releaseVersion} Linux x64`]); },
    verifySigned: () => { git(['verify-tag', tag]); },
    targetCommit: () => git(['rev-list', '-n', '1', tag]),
    tagObject: () => git(['rev-parse', `refs/tags/${tag}`]),
    pushNew: () => { git(['push', canonicalRemote, `refs/tags/${tag}`]); },
  });
  const publishedTag = JSON.parse(gh(['api', `repos/sympoies/dsh-workbench/git/ref/tags/${tag}`]));
  if (publishedTag.object?.sha !== tagObject) {
    throw new Error('canonical remote tag differs from signed local tag');
  }
  const temp = mkdtempSync(join(dirname(packetFile), '.publication-'));
  try {
    const receiptAsset = join(temp, 'dsh-workbench-linux-x64-0.1.0.receipt.json');
    copyFileSync(packetFile, receiptAsset);
    const expected = new Map<string, { path: string; digest: string }>([
      [basename(input.outputArchive), { path: input.outputArchive,
        digest: `sha256:${assets.archiveSha256}` }],
      [basename(ociArchive), { path: ociArchive,
        digest: `sha256:${assets.carrierArchiveSha256}` }],
      [basename(receiptAsset), { path: receiptAsset,
        digest: `sha256:${await sha256(receiptAsset)}` }],
    ]);
  const published = advanceDraftRelease({ tag, notes: notesBytes.toString('utf8'),
    sourceCommit: source.commit, expected }, {
    get: () => releaseAt(tag) as ReleaseRecord | null,
    createDraft: () => { gh(['release', 'create', tag, input.outputArchive, ociArchive, receiptAsset,
      '--draft', '--verify-tag', '--title', 'DSH Workbench 0.1.0 — Linux x64',
      '--notes-file', notesFile]); },
    uploadMissing: paths => { gh(['release', 'upload', tag, ...paths]); },
    publishDraft: () => { gh(['release', 'edit', tag, '--draft=false', '--verify-tag']); },
  });
    process.stdout.write(`${JSON.stringify({ action, tag, url: published.html_url, source: source.commit,
      archiveSha256: assets.archiveSha256,
      manifestSha256: packet.release.manifestSha256,
      ociManifestDigest: packet.carrier.manifestDigest,
      carrierArchiveSha256: assets.carrierArchiveSha256,
      notesSha256, auditUrl, result: 'published-and-verified' })}\n`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
