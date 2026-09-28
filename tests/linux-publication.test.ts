import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceDraftRelease, assertPublicationIdentity, assertAuditComment,
  assertImmutableReleaseSetting, ensureSignedReleaseTag, reviewReleaseAssets,
  type ReleaseRecord } from '../src/linux-publication.ts';

const digest = (character: string) => character.repeat(64);
const packet = {
  schemaVersion: 'dsh-workbench.linux-release-packet.v1',
  release: { releaseVersion: '0.1.0', archiveSha256: digest('a'), manifestSha256: digest('b') },
  carrier: { releaseVersion: '0.1.0', archiveSha256: digest('a'), manifestSha256: digest('b'),
    builderSource: { commit: 'c'.repeat(40), tree: 'd'.repeat(40) },
    manifestDigest: `sha256:${digest('e')}`, carrierArchiveSha256: digest('f') },
};

test('publication binds the exact clean merged source and both assets', () => {
  assertPublicationIdentity(packet, { commit: 'c'.repeat(40), tree: 'd'.repeat(40),
    branch: 'main', clean: true, remoteMain: 'c'.repeat(40) },
  { archiveSha256: digest('a'), carrierArchiveSha256: digest('f') });
  assert.throws(() => assertPublicationIdentity(packet, { commit: 'c'.repeat(40),
    tree: 'd'.repeat(40), branch: 'main', clean: false, remoteMain: 'c'.repeat(40) },
  { archiveSha256: digest('a'), carrierArchiveSha256: digest('f') }), /clean/);
  assert.throws(() => assertPublicationIdentity(packet, { commit: 'c'.repeat(40),
    tree: 'd'.repeat(40), branch: 'main', clean: true, remoteMain: '1'.repeat(40) },
  { archiveSha256: digest('a'), carrierArchiveSha256: digest('f') }), /remote main/);
  assert.throws(() => assertPublicationIdentity(packet, { commit: 'c'.repeat(40),
    tree: 'd'.repeat(40), branch: 'main', clean: true, remoteMain: 'c'.repeat(40) },
  { archiveSha256: digest('a'), carrierArchiveSha256: digest('0') }), /OCI carrier/);
});

test('draft asset review rejects mismatches and identifies only missing assets for safe resume', () => {
  const expected = new Map([['native.tar.gz', { digest: `sha256:${digest('a')}` }],
    ['carrier.tar.gz', { digest: `sha256:${digest('b')}` }]]);
  assert.deepEqual(reviewReleaseAssets([{ name: 'native.tar.gz', digest: `sha256:${digest('a')}` }],
    expected), ['carrier.tar.gz']);
  assert.deepEqual(reviewReleaseAssets([
    { name: 'native.tar.gz', digest: `sha256:${digest('a')}` },
    { name: 'carrier.tar.gz', digest: `sha256:${digest('b')}` },
  ], expected), []);
  assert.throws(() => reviewReleaseAssets([
    { name: 'native.tar.gz', digest: `sha256:${digest('0')}` },
  ], expected), /mismatched/);
  assert.throws(() => reviewReleaseAssets([
    { name: 'native.tar.gz', digest: `sha256:${digest('a')}` },
    { name: 'unexpected', digest: `sha256:${digest('b')}` },
  ], expected), /unreviewed/);
});

test('publication refuses mutable GitHub Releases before creating a tag', () => {
  assert.throws(() => assertImmutableReleaseSetting({ enabled: false }), /not enabled/);
  assertImmutableReleaseSetting({ enabled: true });
});

test('fresh release is published only after exact draft assets are observed', () => {
  const expected = new Map([['native.tar.gz', { path: '/private/native.tar.gz',
    digest: `sha256:${digest('a')}` }]]);
  const calls: string[] = [];
  let current: ReleaseRecord | null = null;
  const published = advanceDraftRelease({ tag: 'v0.1.0', notes: 'reviewed',
    sourceCommit: 'c'.repeat(40), expected }, {
    get: () => current,
    createDraft: () => {
      calls.push('create-draft');
      current = { tag_name: 'v0.1.0', name: 'DSH Workbench 0.1.0 — Linux x64',
        prerelease: false, body: 'reviewed', draft: true,
        html_url: 'https://example.invalid/release',
        assets: [{ name: 'native.tar.gz', digest: `sha256:${digest('a')}` }] };
    },
    uploadMissing: () => { throw new Error('unexpected upload'); },
    publishDraft: () => { calls.push('publish'); current!.draft = false; current!.immutable = true; },
  });
  assert.deepEqual(calls, ['create-draft', 'publish']);
  assert.equal(published.immutable, true);
});

test('resume uploads only missing draft assets and refuses mismatches before publication', () => {
  const expected = new Map([['native.tar.gz', { path: '/private/native.tar.gz',
    digest: `sha256:${digest('a')}` }], ['carrier.tar.gz', { path: '/private/carrier.tar.gz',
    digest: `sha256:${digest('b')}` }]]);
  const calls: string[] = [];
  const current: ReleaseRecord = { tag_name: 'v0.1.0', name: 'DSH Workbench 0.1.0 — Linux x64',
    prerelease: false, body: 'reviewed', draft: true,
    html_url: 'https://example.invalid/release',
    assets: [{ name: 'native.tar.gz', digest: `sha256:${digest('a')}` }] };
  const operations = {
    get: () => current,
    createDraft: () => { throw new Error('unexpected create'); },
    uploadMissing: (paths: string[]) => {
      calls.push(`upload:${paths.join(',')}`);
      current.assets.push({ name: 'carrier.tar.gz', digest: `sha256:${digest('b')}` });
    },
    publishDraft: () => { calls.push('publish'); current.draft = false; current.immutable = true; },
  };
  advanceDraftRelease({ tag: 'v0.1.0', notes: 'reviewed',
    sourceCommit: 'c'.repeat(40), expected }, operations);
  assert.deepEqual(calls, ['upload:/private/carrier.tar.gz', 'publish']);
  current.draft = true;
  current.immutable = false;
  current.assets[0].digest = `sha256:${digest('0')}`;
  calls.length = 0;
  assert.throws(() => advanceDraftRelease({ tag: 'v0.1.0', notes: 'reviewed',
    sourceCommit: 'c'.repeat(40), expected }, operations), /mismatched/);
  assert.deepEqual(calls, []);
});

test('resume refuses unreviewed release title or prerelease metadata', () => {
  const expected = new Map([['native.tar.gz', { path: '/private/native.tar.gz',
    digest: `sha256:${digest('a')}` }]]);
  const current: ReleaseRecord = { tag_name: 'v0.1.0', name: 'Wrong title',
    prerelease: false, body: 'reviewed', draft: true,
    html_url: 'https://example.invalid/release',
    assets: [{ name: 'native.tar.gz', digest: `sha256:${digest('a')}` }] };
  let publishes = 0;
  const operations = {
    get: () => current,
    createDraft: () => { throw new Error('unexpected create'); },
    uploadMissing: () => { throw new Error('unexpected upload'); },
    publishDraft: () => { publishes++; },
  };
  const input = { tag: 'v0.1.0', notes: 'reviewed', sourceCommit: 'c'.repeat(40), expected };
  assert.throws(() => advanceDraftRelease(input, operations), /identity/);
  current.name = 'DSH Workbench 0.1.0 — Linux x64';
  current.prerelease = true;
  assert.throws(() => advanceDraftRelease(input, operations), /identity/);
  assert.equal(publishes, 0);
});

test('a successful publish followed by a timeout can be verified on retry', () => {
  const expected = new Map([['native.tar.gz', { path: '/private/native.tar.gz',
    digest: `sha256:${digest('a')}` }]]);
  const current: ReleaseRecord = { tag_name: 'v0.1.0', name: 'DSH Workbench 0.1.0 — Linux x64',
    prerelease: false, body: 'reviewed', draft: true,
    html_url: 'https://example.invalid/release',
    assets: [{ name: 'native.tar.gz', digest: `sha256:${digest('a')}` }] };
  const operations = {
    get: () => current,
    createDraft: () => { throw new Error('unexpected create'); },
    uploadMissing: () => { throw new Error('unexpected upload'); },
    publishDraft: () => { current.draft = false; current.immutable = true;
      throw new Error('simulated timeout after server committed publication'); },
  };
  const input = { tag: 'v0.1.0', notes: 'reviewed', sourceCommit: 'c'.repeat(40), expected };
  assert.throws(() => advanceDraftRelease(input, operations), /simulated timeout/);
  assert.equal(advanceDraftRelease(input, operations).immutable, true);
});

test('an exact signed tag can resume after push without moving the remote ref', () => {
  const calls: string[] = [];
  let local = false;
  const commit = 'c'.repeat(40);
  const object = 'a'.repeat(40);
  const remoteRefs = `${object}\trefs/tags/v0.1.0\n${commit}\trefs/tags/v0.1.0^{}\n`;
  const operations = {
    localExists: () => local,
    fetchExactRemote: () => { calls.push('fetch'); local = true; },
    createSigned: () => { calls.push('create'); local = true; },
    verifySigned: () => { calls.push('verify'); },
    targetCommit: () => commit,
    tagObject: () => object,
    pushNew: () => { calls.push('push'); },
  };
  assert.equal(ensureSignedReleaseTag('v0.1.0', commit, remoteRefs, operations), object);
  assert.deepEqual(calls, ['fetch', 'verify']);
  calls.length = 0;
  assert.equal(ensureSignedReleaseTag('v0.1.0', commit, remoteRefs, operations), object);
  assert.deepEqual(calls, ['verify']);
  assert.throws(() => ensureSignedReleaseTag('v0.1.0', commit,
    remoteRefs.replace(object, 'b'.repeat(40)), operations), /canonical remote tag differs/);
  assert.deepEqual(calls, ['verify', 'verify']);
});

test('new signed tag is verified before pushing; wrong target is never pushed', () => {
  const calls: string[] = [];
  let local = false;
  const ops = {
    localExists: () => local,
    fetchExactRemote: () => { throw new Error('unexpected fetch'); },
    createSigned: () => { calls.push('create'); local = true; },
    verifySigned: () => { calls.push('verify'); },
    targetCommit: () => '0'.repeat(40),
    tagObject: () => 'a'.repeat(40),
    pushNew: () => { calls.push('push'); },
  };
  assert.throws(() => ensureSignedReleaseTag('v0.1.0', 'c'.repeat(40), '', ops), /target/);
  assert.deepEqual(calls, ['create', 'verify']);
});

test('publication audit must approve the exact four digests and source', () => {
  const body = `Decision: approved for publication\n${packet.carrier.builderSource.commit}\n`
    + `${packet.release.archiveSha256}\n${packet.release.manifestSha256}\n`
    + `${packet.carrier.manifestDigest}\n${packet.carrier.carrierArchiveSha256}\n${digest('9')}\n`;
  assertAuditComment(packet, { body, authorAssociation: 'MEMBER' }, digest('9'));
  assert.throws(() => assertAuditComment(packet,
    { body: body.replace(packet.release.archiveSha256, digest('0')), authorAssociation: 'MEMBER' },
    digest('9')),
  /archive digest/);
  assert.throws(() => assertAuditComment(packet,
    { body, authorAssociation: 'NONE' }, digest('9')), /reviewer/);
  assert.throws(() => assertAuditComment(packet,
    { body, authorAssociation: 'MEMBER' }, digest('0')), /release notes digest/);
});
