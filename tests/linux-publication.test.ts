import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceDraftRelease, assertPublicationIdentity, assertAuditComment,
  assertImmutableReleaseSetting, canonicalPublicationReceipt, ensureSignedReleaseTag,
  releaseForTag, reviewReleaseAssets, type ReleaseRecord } from '../src/linux-publication.ts';

const digest = (character: string) => character.repeat(64);
const packet = {
  schemaVersion: 'dsh-workbench.linux-release-packet.v1',
  release: { releaseVersion: '0.1.0', archiveSha256: digest('a'), manifestSha256: digest('b'),
    files: 133, peerArchives: 83 },
  carrier: { schemaVersion: 'dsh-workbench.linux-oci-carrier-receipt.v1',
    releaseVersion: '0.1.0', archiveSha256: digest('a'), manifestSha256: digest('b'),
    builderSource: { commit: 'c'.repeat(40), tree: 'd'.repeat(40) },
    manifestDigest: `sha256:${digest('e')}`, indexSha256: digest('7'),
    carrierArchiveSha256: digest('f') },
};
const title = 'DSH Workbench 0.1.0 — Linux x64';

function releaseRecord(overrides: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return { id: 41, tag_name: 'v0.1.0', name: title, prerelease: false, body: 'reviewed',
    draft: true, html_url: 'https://example.invalid/release',
    assets: [{ name: 'native.tar.gz', digest: `sha256:${digest('a')}` }], ...overrides };
}

function nativeOnly() {
  return new Map([['native.tar.gz', { path: '/private/native.tar.gz',
    digest: `sha256:${digest('a')}` }]]);
}

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

test('public receipt is the canonical path-free packet and nothing else', () => {
  const canonical = canonicalPublicationReceipt(packet);
  assert.equal(canonical, `${JSON.stringify(packet, null, 2)}\n`);
  assert.throws(() => canonicalPublicationReceipt({ ...packet,
    buildInput: '/private/build-input.json' }), /receipt fields/);
  assert.throws(() => canonicalPublicationReceipt({ ...packet,
    release: { ...packet.release, outputRoot: '/private/root' } }), /receipt fields/);
  assert.throws(() => canonicalPublicationReceipt({ ...packet,
    carrier: { ...packet.carrier, builderSource: { ...packet.carrier.builderSource,
      checkout: '/private/source' } } }), /receipt fields/);
  assert.throws(() => canonicalPublicationReceipt({ ...packet,
    release: { ...packet.release, files: -1 } }), /receipt fields/);
  assert.throws(() => canonicalPublicationReceipt({ ...packet,
    release: { ...packet.release, peerArchives: 0 } }), /receipt fields/);
  assert.throws(() => canonicalPublicationReceipt({ ...packet,
    carrier: { ...packet.carrier, installRoot: '/private/install' } }), /receipt fields/);
  assert.throws(() => canonicalPublicationReceipt({ ...packet,
    carrier: { ...packet.carrier, schemaVersion: 'other' } }), /receipt fields/);
  assert.throws(() => canonicalPublicationReceipt({ ...packet,
    carrier: { ...packet.carrier, indexSha256: '/private/index.json' } }), /receipt fields/);
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

test('release lookup sees drafts and refuses an ambiguous tag', () => {
  const draft = releaseRecord();
  assert.equal(releaseForTag([releaseRecord({ id: 7, tag_name: 'v0.0.9', draft: false }), draft],
    'v0.1.0'), draft);
  assert.equal(releaseForTag([], 'v0.1.0'), null);
  assert.throws(() => releaseForTag([draft, releaseRecord({ id: 42 })], 'v0.1.0'),
    /multiple releases/);
});

test('fresh release creates one draft and publishes that exact release id', () => {
  const calls: string[] = [];
  const releases: ReleaseRecord[] = [];
  const operations = {
    list: () => releases,
    get: (id: number) => releases.find(release => release.id === id)!,
    createDraft: () => { calls.push('create-draft'); releases.push(releaseRecord()); },
    uploadMissing: () => { throw new Error('unexpected upload'); },
    publishDraft: (id: number) => {
      calls.push(`publish:${id}`);
      releases[0].draft = false;
      releases[0].immutable = true;
    },
  };
  const input = { tag: 'v0.1.0', notes: 'reviewed', sourceCommit: 'c'.repeat(40),
    expected: nativeOnly() };
  const published = advanceDraftRelease(input, operations);
  assert.deepEqual(calls, ['create-draft', 'publish:41']);
  assert.equal(published.immutable, true);
  calls.length = 0;
  assert.equal(advanceDraftRelease(input, operations).id, 41);
  assert.deepEqual(calls, []);
});

test('publication refuses a second release or a different id for the tag', () => {
  for (const variant of ['second-release', 'different-id']) {
    const releases = [releaseRecord()];
    const operations = {
      list: () => releases,
      get: (id: number) => variant === 'different-id' && !releases[0].draft
        ? { ...releases[0], id: id + 1 } : releases[0],
      createDraft: () => { throw new Error('unexpected create'); },
      uploadMissing: () => { throw new Error('unexpected upload'); },
      publishDraft: () => {
        releases[0].draft = false;
        releases[0].immutable = true;
        if (variant === 'second-release') {
          releases.push(releaseRecord({ id: 42, draft: false, immutable: true }));
        }
      },
    };
    assert.throws(() => advanceDraftRelease({ tag: 'v0.1.0', notes: 'reviewed',
      sourceCommit: 'c'.repeat(40), expected: nativeOnly() }, operations),
    /identity differs|multiple releases/);
  }
});

test('published release must report immutable true', () => {
  for (const immutable of [false, undefined]) {
    const current = releaseRecord();
    const operations = {
      list: () => [current],
      get: () => current,
      createDraft: () => { throw new Error('unexpected create'); },
      uploadMissing: () => { throw new Error('unexpected upload'); },
      publishDraft: () => { current.draft = false; current.immutable = immutable; },
    };
    assert.throws(() => advanceDraftRelease({ tag: 'v0.1.0', notes: 'reviewed',
      sourceCommit: 'c'.repeat(40), expected: nativeOnly() }, operations), /identity differs/);
  }
});

test('resume uploads only missing draft assets and refuses mismatches before publication', () => {
  const expected = new Map([['native.tar.gz', { path: '/private/native.tar.gz',
    digest: `sha256:${digest('a')}` }], ['carrier.tar.gz', { path: '/private/carrier.tar.gz',
    digest: `sha256:${digest('b')}` }]]);
  const calls: string[] = [];
  const current = releaseRecord();
  const operations = {
    list: () => [current],
    get: () => current,
    createDraft: () => { throw new Error('unexpected create'); },
    uploadMissing: (paths: string[]) => {
      calls.push(`upload:${paths.join(',')}`);
      current.assets.push({ name: 'carrier.tar.gz', digest: `sha256:${digest('b')}` });
    },
    publishDraft: (id: number) => {
      calls.push(`publish:${id}`); current.draft = false; current.immutable = true;
    },
  };
  advanceDraftRelease({ tag: 'v0.1.0', notes: 'reviewed',
    sourceCommit: 'c'.repeat(40), expected }, operations);
  assert.deepEqual(calls, ['upload:/private/carrier.tar.gz', 'publish:41']);
  current.draft = true;
  current.immutable = false;
  current.assets[0].digest = `sha256:${digest('0')}`;
  calls.length = 0;
  assert.throws(() => advanceDraftRelease({ tag: 'v0.1.0', notes: 'reviewed',
    sourceCommit: 'c'.repeat(40), expected }, operations), /mismatched/);
  assert.deepEqual(calls, []);
});

test('resume refuses unreviewed release title, prerelease metadata or notes', () => {
  const current = releaseRecord({ name: 'Wrong title' });
  let publishes = 0;
  const operations = {
    list: () => [current],
    get: () => current,
    createDraft: () => { throw new Error('unexpected create'); },
    uploadMissing: () => { throw new Error('unexpected upload'); },
    publishDraft: () => { publishes++; },
  };
  const input = { tag: 'v0.1.0', notes: 'reviewed', sourceCommit: 'c'.repeat(40),
    expected: nativeOnly() };
  assert.throws(() => advanceDraftRelease(input, operations), /identity/);
  current.name = title;
  current.prerelease = true;
  assert.throws(() => advanceDraftRelease(input, operations), /identity/);
  current.prerelease = false;
  current.body = 'tampered';
  assert.throws(() => advanceDraftRelease(input, operations), /identity/);
  assert.equal(publishes, 0);
});

test('notes changed during publication fail the final check', () => {
  const current = releaseRecord();
  const operations = {
    list: () => [current],
    get: () => current,
    createDraft: () => { throw new Error('unexpected create'); },
    uploadMissing: () => { throw new Error('unexpected upload'); },
    publishDraft: () => { current.draft = false; current.immutable = true;
      current.body = 'edited after review'; },
  };
  assert.throws(() => advanceDraftRelease({ tag: 'v0.1.0', notes: 'reviewed',
    sourceCommit: 'c'.repeat(40), expected: nativeOnly() }, operations), /identity differs/);
});

test('a successful publish followed by a timeout can be verified on retry', () => {
  const current = releaseRecord();
  const operations = {
    list: () => [current],
    get: () => current,
    createDraft: () => { throw new Error('unexpected create'); },
    uploadMissing: () => { throw new Error('unexpected upload'); },
    publishDraft: () => { current.draft = false; current.immutable = true;
      throw new Error('simulated timeout after server committed publication'); },
  };
  const input = { tag: 'v0.1.0', notes: 'reviewed', sourceCommit: 'c'.repeat(40),
    expected: nativeOnly() };
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

test('new signed tag is created, verified, then pushed', () => {
  const calls: string[] = [];
  let local = false;
  const ops = {
    localExists: () => local,
    fetchExactRemote: () => { throw new Error('unexpected fetch'); },
    createSigned: () => { calls.push('create'); local = true; },
    verifySigned: () => { calls.push('verify'); },
    targetCommit: () => 'c'.repeat(40),
    tagObject: () => 'a'.repeat(40),
    pushNew: () => { calls.push('push'); },
  };
  assert.equal(ensureSignedReleaseTag('v0.1.0', 'c'.repeat(40), '', ops), 'a'.repeat(40));
  assert.deepEqual(calls, ['create', 'verify', 'push']);
});

test('new signed tag with the wrong target is never pushed', () => {
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

test('publication audit must approve the exact source, five digests and notes', () => {
  const digests = { notesSha256: digest('9'), receiptSha256: digest('8') };
  const body = `Decision: approved for publication\n${packet.carrier.builderSource.commit}\n`
    + `${packet.release.archiveSha256}\n${packet.release.manifestSha256}\n`
    + `${packet.carrier.manifestDigest}\n${packet.carrier.carrierArchiveSha256}\n`
    + `${digest('8')}\n${digest('9')}\n`;
  const approval = { body, reviewerRole: 'admin', edited: false };
  assertAuditComment(packet, approval, digests);
  assertAuditComment(packet, { ...approval, reviewerRole: 'maintain' }, digests);
  assert.throws(() => assertAuditComment(packet,
    { ...approval, body: body.replace(packet.release.archiveSha256, digest('0')) }, digests),
  /archive digest/);
  assert.throws(() => assertAuditComment(packet, approval,
    { ...digests, receiptSha256: digest('0') }), /receipt digest/);
  assert.throws(() => assertAuditComment(packet, approval,
    { ...digests, notesSha256: digest('0') }), /release notes digest/);
  for (const reviewerRole of ['write', 'triage', 'read', 'none']) {
    assert.throws(() => assertAuditComment(packet, { ...approval, reviewerRole }, digests),
      /reviewer/);
  }
  assert.throws(() => assertAuditComment(packet, { ...approval, edited: true }, digests),
    /edited/);
});
