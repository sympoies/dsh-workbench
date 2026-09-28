type PublicationPacket = {
  schemaVersion?: unknown;
  release?: { releaseVersion?: unknown; archiveSha256?: unknown; manifestSha256?: unknown };
  carrier?: { releaseVersion?: unknown; archiveSha256?: unknown; manifestSha256?: unknown;
    builderSource?: { commit?: unknown; tree?: unknown }; manifestDigest?: unknown;
    carrierArchiveSha256?: unknown };
};

type Source = { commit: string; tree: string; branch: string; clean: boolean; remoteMain: string };
type Assets = { archiveSha256: string; carrierArchiveSha256: string };
const digest = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;

export function assertPublicationIdentity(packet: PublicationPacket, source: Source, assets: Assets):
  asserts packet is PublicationPacket & {
    release: { releaseVersion: string; archiveSha256: string; manifestSha256: string };
    carrier: { releaseVersion: string; archiveSha256: string; manifestSha256: string;
      builderSource: { commit: string; tree: string }; manifestDigest: string;
      carrierArchiveSha256: string };
  } {
  const release = packet.release;
  const carrier = packet.carrier;
  if (packet.schemaVersion !== 'dsh-workbench.linux-release-packet.v1'
    || release?.releaseVersion !== '0.1.0' || carrier?.releaseVersion !== '0.1.0') {
    throw new Error('publication packet is not the first Linux release');
  }
  if (typeof release.archiveSha256 !== 'string' || !digest.test(release.archiveSha256)
    || typeof release.manifestSha256 !== 'string' || !digest.test(release.manifestSha256)
    || typeof carrier.carrierArchiveSha256 !== 'string'
    || !digest.test(carrier.carrierArchiveSha256)
    || typeof carrier.manifestDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(carrier.manifestDigest)
    || carrier.archiveSha256 !== release.archiveSha256
    || carrier.manifestSha256 !== release.manifestSha256) {
    throw new Error('publication packet digests are inconsistent');
  }
  if (source.branch !== 'main' || !source.clean) throw new Error('publication requires clean main');
  if (!commit.test(source.commit) || !commit.test(source.tree)
    || carrier.builderSource?.commit !== source.commit
    || carrier.builderSource?.tree !== source.tree) {
    throw new Error('publication source differs from the authenticated release');
  }
  if (source.remoteMain !== source.commit) throw new Error('remote main differs from publication source');
  if (assets.archiveSha256 !== release.archiveSha256) throw new Error('Linux archive digest differs');
  if (assets.carrierArchiveSha256 !== carrier.carrierArchiveSha256) {
    throw new Error('OCI carrier digest differs');
  }
}

const receiptShape = {
  top: ['schemaVersion', 'release', 'carrier'],
  release: ['releaseVersion', 'archiveSha256', 'manifestSha256', 'files', 'peerArchives'],
  carrier: ['schemaVersion', 'releaseVersion', 'archiveSha256', 'manifestSha256', 'builderSource',
    'manifestDigest', 'indexSha256', 'carrierArchiveSha256'],
  builderSource: ['commit', 'tree'],
};

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

// The public receipt asset is rebuilt from known path-free fields, so an
// unexpected field in the private packet cannot reach an immutable release.
export function canonicalPublicationReceipt(packet: unknown): string {
  const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
  if (!exactKeys(packet, receiptShape.top) || !exactKeys(packet.release, receiptShape.release)
    || !exactKeys(packet.carrier, receiptShape.carrier)
    || !exactKeys(packet.carrier.builderSource, receiptShape.builderSource)
    || packet.carrier.schemaVersion !== 'dsh-workbench.linux-oci-carrier-receipt.v1'
    || typeof packet.carrier.indexSha256 !== 'string' || !digest.test(packet.carrier.indexSha256)
    || !count(packet.release.files) || !count(packet.release.peerArchives)) {
    throw new Error('publication packet has unexpected receipt fields');
  }
  const pick = (value: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(keys.map(key => [key, value[key]]));
  const carrier = pick(packet.carrier, receiptShape.carrier);
  carrier.builderSource = pick(packet.carrier.builderSource, receiptShape.builderSource);
  return `${JSON.stringify({ schemaVersion: packet.schemaVersion,
    release: pick(packet.release, receiptShape.release), carrier }, null, 2)}\n`;
}

export function assertAuditComment(packet: PublicationPacket,
  comment: { body: string; reviewerRole: string; edited: boolean },
  digests: { notesSha256: string; receiptSha256: string }): void {
  if (!['admin', 'maintain'].includes(comment.reviewerRole)) {
    throw new Error('publication audit reviewer lacks admin or maintain permission');
  }
  if (comment.edited) throw new Error('publication audit comment was edited after approval');
  if (!/Decision:\s*approved for publication/i.test(comment.body)) {
    throw new Error('publication audit has no explicit approval');
  }
  for (const [label, value] of [
    ['source commit', packet.carrier?.builderSource?.commit],
    ['archive digest', packet.release?.archiveSha256],
    ['release manifest digest', packet.release?.manifestSha256],
    ['OCI manifest digest', packet.carrier?.manifestDigest],
    ['OCI carrier digest', packet.carrier?.carrierArchiveSha256],
    ['receipt digest', digests.receiptSha256],
    ['release notes digest', digests.notesSha256],
  ]) {
    if (typeof value !== 'string' || !comment.body.includes(value)) {
      throw new Error(`publication audit lacks exact ${label}`);
    }
  }
}

export function reviewReleaseAssets(
  assets: Array<{ name: string; digest: string }>,
  expected: ReadonlyMap<string, { digest: string }>,
): string[] {
  const missing = new Set(expected.keys());
  for (const asset of assets) {
    const reviewed = expected.get(asset.name);
    if (!reviewed || reviewed.digest !== asset.digest || !missing.has(asset.name)) {
      throw new Error('release has an unreviewed or mismatched asset');
    }
    missing.delete(asset.name);
  }
  return [...missing];
}

export function assertImmutableReleaseSetting(setting: { enabled?: unknown }): void {
  if (setting.enabled !== true) throw new Error('GitHub immutable releases are not enabled');
}

export type ReleaseRecord = { id: number; tag_name: string; name: string; prerelease: boolean;
  body: string; draft: boolean;
  immutable?: boolean; html_url: string; target_commitish?: string;
  assets: Array<{ name: string; digest: string }> };

// GitHub's tag lookup omits drafts, so the caller supplies the full release
// list and every later step addresses the one matching release by id.
export function releaseForTag(releases: ReleaseRecord[], tag: string): ReleaseRecord | null {
  const matches = releases.filter(release => release.tag_name === tag);
  if (matches.length > 1) throw new Error('multiple releases use the publication tag');
  return matches[0] ?? null;
}

export function advanceDraftRelease(input: { tag: string; notes: string; sourceCommit: string;
  expected: ReadonlyMap<string, { path: string; digest: string }> }, operations: {
    list: () => ReleaseRecord[];
    get: (id: number) => ReleaseRecord;
    createDraft: () => void;
    uploadMissing: (paths: string[]) => void;
    publishDraft: (id: number) => void;
  }): ReleaseRecord {
  let release = releaseForTag(operations.list(), input.tag);
  if (!release) {
    operations.createDraft();
    release = releaseForTag(operations.list(), input.tag);
  }
  if (!release || release.tag_name !== input.tag
    || release.name !== 'DSH Workbench 0.1.0 — Linux x64' || release.prerelease !== false
    || release.body !== input.notes
    || (release.target_commitish && !['main', input.sourceCommit].includes(release.target_commitish))) {
    throw new Error('release identity or reviewed notes differ');
  }
  const id = release.id;
  const missing = reviewReleaseAssets(release.assets ?? [], input.expected);
  if (missing.length && !release.draft) throw new Error('published release lacks reviewed assets');
  if (missing.length) {
    operations.uploadMissing(missing.map(name => input.expected.get(name)!.path));
    release = operations.get(id);
    if (!release?.draft || release.assets?.length !== input.expected.size
      || reviewReleaseAssets(release.assets, input.expected).length) {
      throw new Error('draft asset digests could not be verified');
    }
  }
  if (release.draft) operations.publishDraft(id);
  const published = operations.get(id);
  if (!published || published.id !== id || published.draft || published.immutable !== true
    || published.tag_name !== input.tag
    || published.name !== 'DSH Workbench 0.1.0 — Linux x64'
    || published.prerelease !== false
    || !published.html_url?.endsWith(`/releases/tag/${input.tag}`)
    || published.body !== input.notes || published.assets?.length !== input.expected.size
    || reviewReleaseAssets(published.assets, input.expected).length
    || releaseForTag(operations.list(), input.tag)?.id !== id) {
    throw new Error('published release identity differs');
  }
  return published;
}

export function ensureSignedReleaseTag(tag: string, sourceCommit: string,
  remoteRefs: string, operations: {
    localExists: () => boolean;
    fetchExactRemote: () => void;
    createSigned: () => void;
    verifySigned: () => void;
    targetCommit: () => string;
    tagObject: () => string;
    pushNew: () => void;
  }): string {
  const refs = new Map(remoteRefs.split('\n').filter(Boolean).map(line => {
    const [sha, ref] = line.split('\t');
    return [ref, sha];
  }));
  const remoteObject = refs.get(`refs/tags/${tag}`);
  const remoteCommit = refs.get(`refs/tags/${tag}^{}`);
  if (remoteObject && !operations.localExists()) operations.fetchExactRemote();
  else if (!remoteObject && !operations.localExists()) operations.createSigned();
  operations.verifySigned();
  if (operations.targetCommit() !== sourceCommit) {
    throw new Error('signed release tag does not target the authenticated source');
  }
  const object = operations.tagObject();
  if (remoteObject && (remoteObject !== object || remoteCommit !== sourceCommit)) {
    throw new Error('canonical remote tag differs from the reviewed signed tag');
  }
  if (!remoteObject) operations.pushNew();
  return object;
}
