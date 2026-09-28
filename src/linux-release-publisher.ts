import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceDraftRelease, assertAuditComment, assertImmutableReleaseSetting,
  canonicalPublicationReceipt, ensureSignedReleaseTag,
  assertPublicationIdentity, type ReleaseRecord } from './linux-publication.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const canonicalRemote = 'https://github.com/sympoies/dsh-workbench.git';
// The checkout is proven to be clean canonical main before publication, so its
// contract names the release being published.
const { version, tag } = (JSON.parse(readFileSync(join(repo, 'compatibility/workbench.json'), 'utf8')) as
  { release: { version: string; tag: string } }).release;
const assetStem = `dsh-workbench-linux-x64-${version}`;
const title = `DSH Workbench ${version} — Linux x64`;
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
  function releases(): ReleaseRecord[] {
    return (JSON.parse(gh(['api', '--paginate', '--slurp',
      'repos/sympoies/dsh-workbench/releases?per_page=100'])) as ReleaseRecord[][]).flat();
  }
  function releaseById(id: number): ReleaseRecord {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('GitHub release id is invalid');
    return JSON.parse(gh(['api', `repos/sympoies/dsh-workbench/releases/${id}`]));
  }

  const packet = json(packetFile);
  const receiptBytes = canonicalPublicationReceipt(packet);
  if (readFileSync(packetFile, 'utf8') !== receiptBytes) {
    throw new Error('publication packet is not the canonical path-free receipt');
  }
  const receiptSha256 = createHash('sha256').update(receiptBytes).digest('hex');
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
  assertPublicationIdentity(packet, source, assets, version);
  assertImmutableReleaseSetting(JSON.parse(gh(['api',
    'repos/sympoies/dsh-workbench/immutable-releases'])));
  if (basename(input.outputArchive) !== `${assetStem}.tar.gz`
    || basename(ociArchive) !== `${assetStem}.oci.tar.gz`) {
    throw new Error('publication asset names are not canonical');
  }
  if (!lstatSync(notesFile).isFile() || !readFileSync(notesFile, 'utf8').includes(`DSH Workbench ${version}`)) {
    throw new Error(`release notes do not identify Workbench ${version}`);
  }
  command('/usr/bin/bash', [join(repo, 'scripts/check-publication.sh'), '--artifact', notesFile,
    '--artifact', packetFile]);
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
    process.stdout.write(`${JSON.stringify({ action, tag, source: source.commit,
      archiveSha256: assets.archiveSha256,
      manifestSha256: packet.release.manifestSha256,
      ociManifestDigest: packet.carrier.manifestDigest,
      carrierArchiveSha256: assets.carrierArchiveSha256,
      receiptSha256, notesSha256, result: 'verified' })}\n`);
    return;
  }

  const match = /^https:\/\/github\.com\/sympoies\/dsh-workbench\/issues\/8#issuecomment-(\d+)$/.exec(auditUrl);
  if (!match) throw new Error('publication audit URL must identify an issue #8 comment');
  const audit = JSON.parse(gh(['api', `repos/sympoies/dsh-workbench/issues/comments/${match[1]}`]));
  if (audit.html_url !== auditUrl || typeof audit.user?.login !== 'string'
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(audit.user.login)) {
    throw new Error('publication audit comment identity differs');
  }
  const reviewer = JSON.parse(gh(['api',
    `repos/sympoies/dsh-workbench/collaborators/${audit.user.login}/permission`]));
  assertAuditComment(packet, { body: audit.body, reviewerRole: reviewer.role_name,
    edited: audit.created_at !== audit.updated_at }, { notesSha256, receiptSha256 });

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
    const receiptAsset = join(temp, `${assetStem}.receipt.json`);
    writeFileSync(receiptAsset, receiptBytes, { flag: 'wx', mode: 0o600 });
    const expected = new Map<string, { path: string; digest: string }>([
      [basename(input.outputArchive), { path: input.outputArchive,
        digest: `sha256:${assets.archiveSha256}` }],
      [basename(ociArchive), { path: ociArchive,
        digest: `sha256:${assets.carrierArchiveSha256}` }],
      [basename(receiptAsset), { path: receiptAsset,
        digest: `sha256:${receiptSha256}` }],
    ]);
    const published = advanceDraftRelease({ tag, title, notes: notesBytes.toString('utf8'),
      sourceCommit: source.commit, expected }, {
      list: releases,
      get: releaseById,
      createDraft: () => { gh(['release', 'create', tag, input.outputArchive, ociArchive,
        receiptAsset, '--draft', '--verify-tag', '--title', title,
        '--notes-file', notesFile]); },
      // Only one release can carry the tag here, so gh resolves this exact draft.
      uploadMissing: paths => { gh(['release', 'upload', tag, ...paths]); },
      publishDraft: id => { gh(['api', '-X', 'PATCH',
        `repos/sympoies/dsh-workbench/releases/${id}`, '-F', 'draft=false']); },
    });
    process.stdout.write(`${JSON.stringify({ action, tag, url: published.html_url, source: source.commit,
      archiveSha256: assets.archiveSha256,
      manifestSha256: packet.release.manifestSha256,
      ociManifestDigest: packet.carrier.manifestDigest,
      carrierArchiveSha256: assets.carrierArchiveSha256,
      receiptSha256, notesSha256, auditUrl, result: 'published-and-verified' })}\n`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
