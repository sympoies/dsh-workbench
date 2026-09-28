import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { stageCombinedProfile, stageCombinedProfileFromPinnedKit } from '../src/combined-profile.ts';
import { inspectPeerArtifact, inspectSemanticPeerArtifact, normalizePeerArtifact } from '../src/package-artifact.ts';

const revision = '46a7f68b0922371ce7144b668b90e377d8e799f4';
const releaseVersion = (JSON.parse(readFileSync(new URL('../compatibility/workbench.json', import.meta.url), 'utf8')) as
  { release: { version: string } }).release.version;

function tarEntry(path: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(path);
  header.write('0000644\0', 100);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
  header[156] = 48;
  const padding = Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length);
  return Buffer.concat([header, bytes, padding]);
}

function archive(name: string, version: string, clientCode?: string): Buffer {
  const entries = [tarEntry('package/package.json', Buffer.from(JSON.stringify({ name, version })))];
  if (clientCode !== undefined) entries.push(tarEntry('package/lib/client.js', Buffer.from(clientCode)));
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-workbench-combined-'));
  const artifacts = join(root, 'input');
  mkdirSync(artifacts);
  const cliArchive = join(artifacts, 'cli.tgz');
  const cliBytes = archive('@deepseek-ai/dsh', '0.1.7-rc.1');
  writeFileSync(cliArchive, cliBytes);
  const cliIntegrity = `sha512-${createHash('sha512').update(cliBytes).digest('base64')}`;
  const tuiArchive = join(artifacts, 'tui.tgz');
  const tuiBytes = Buffer.from('reviewed TUI archive fixture');
  writeFileSync(tuiArchive, tuiBytes);
  const webArchive = join(artifacts, 'web.tgz');
  writeFileSync(webArchive, archive('@sympoies/dsh-workbench-web', releaseVersion,
    'export const marker = 1;'));
  const webDigest = inspectPeerArtifact(readFileSync(webArchive)).artifactSha256;
  const tuiIntegrity = `sha512-${createHash('sha512').update(tuiBytes).digest('base64')}`;
  const entries = [
    ['@deepseek-ai/cordis', '4.0.4'],
    ['@deepseek-ai/dsh-sandbox', '0.1.7-rc.1'],
    ['@deepseek-ai/node-addon-system', '0.1.2'],
    ['@deepseek-ai/node-addon-system-darwin-arm64', '0.1.2'],
    ['@deepseek-ai/node-addon-system-darwin-x64', '0.1.2'],
    ['@deepseek-ai/node-addon-system-linux-arm64', '0.1.2'],
    ['@deepseek-ai/node-addon-system-linux-x64', '0.1.2'],
  ] as const;
  const packages = entries.map(([name, version], index) => {
    const path = join(artifacts, `package-${index}.tgz`);
    const bytes = archive(name, version);
    writeFileSync(path, bytes);
    return {
      name, version, path,
      tarball_sha256: createHash('sha256').update(bytes).digest('hex'),
      artifact_sha256: inspectPeerArtifact(bytes).artifactSha256,
    };
  });
  const receipt = {
    schema_version: 'dsh-runtime-kit.dsh-peer-pack.v1',
    ok: true,
    data: {
      channel: 'pinned', revision, patch_state: 'patched',
      patch_id: 'native-execution-boundaries-v5',
      upstream_checkout_clean: false,
      packages,
    },
  };
  const kitManifest = {
    schema_version: 'dsh-runtime-kit.dsh-compatibility.v1',
    repository: 'https://github.com/deepseek-ai/deepseek-harness',
    validated_releases: { '0.1.7-rc.1': { revision } },
    public_packages: Object.fromEntries(entries.slice(0, 2).map(([name]) => [name, {}])),
    workspace_artifacts: Object.fromEntries(packages.map(row =>
      [row.name, { version: row.version, artifact_sha256: row.artifact_sha256 }])),
    patched_workspace_artifacts: {
      '@deepseek-ai/dsh-sandbox': packages[1].artifact_sha256,
    },
    registry_workspace_artifacts: Object.fromEntries(packages.slice(2).map(row => [row.name, {
      integrity: `sha512-${createHash('sha512').update(readFileSync(row.path)).digest('base64')}`,
      ...(row.name === '@deepseek-ai/node-addon-system' ? {}
        : { platform: row.name.slice('@deepseek-ai/node-addon-system-'.length) }),
    }])),
  };
  return { root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest, cliArchive, cliIntegrity };
}

test('portable profile authenticates every native archive and overrides only the host platform', () => {
  const { cliArchive, cliIntegrity, root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const profile = join(root, 'profile');
    stageCombinedProfile({ cliArchive, profile, receipt, kitManifest, tuiArchive, webArchive }, tuiIntegrity, webDigest, cliIntegrity);
    const workspace = readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8');
    for (const row of receipt.data.packages.slice(2)) {
      const file = `${row.name.slice(1).replace('/', '-')}-${row.version}.tgz`;
      assert.deepEqual(readFileSync(join(profile, 'artifacts', file)), readFileSync(row.path));
      const selected = row.name === '@deepseek-ai/node-addon-system'
        || row.name === `@deepseek-ai/node-addon-system-${process.platform}-${process.arch}`;
      assert.equal(workspace.includes(`'${row.name}': 'file:`), selected,
        `Nonhost optional native archive must not receive a local-file override: ${row.name}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('profile roots the authenticated host closure so plugin resolution cannot fall back to CLI scopes', () => {
  const { cliArchive, cliIntegrity, root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const additional = ['@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-scope'].map(name => {
      const version = '0.1.7-rc.1';
      const bytes = archive(name, version);
      const path = join(root, `${name.slice(1).replace('/', '-')}.tgz`);
      writeFileSync(path, bytes);
      return { name, version, path, tarball_sha256: createHash('sha256').update(bytes).digest('hex'),
        artifact_sha256: inspectPeerArtifact(bytes).artifactSha256 };
    });
    const complete = { ...receipt, data: { ...receipt.data, packages: [...receipt.data.packages, ...additional] } };
    const manifest = { ...kitManifest, workspace_artifacts: { ...kitManifest.workspace_artifacts,
      ...Object.fromEntries(additional.map(row => [row.name, { version: row.version, artifact_sha256: row.artifact_sha256 }])) } };
    const profile = join(root, 'profile');
    stageCombinedProfile({ cliArchive, profile, receipt: complete, kitManifest: manifest, tuiArchive, webArchive }, tuiIntegrity, webDigest, cliIntegrity);
    const dependencies = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies;
    for (const row of [...additional, ...receipt.data.packages]) {
      const platform = manifest.registry_workspace_artifacts[row.name]?.platform;
      const selected = platform === undefined || platform === `${process.platform}-${process.arch}`;
      assert.equal(dependencies[row.name], selected
        ? `file:artifacts/${row.name.slice(1).replace('/', '-')}-${row.version}.tgz` : undefined,
      `Host-compatible closure package must be directly resolvable from the profile: ${row.name}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('portable profile rejects changed native compressed bytes with rewritten receipt SHA-256', () => {
  const { cliArchive, cliIntegrity, root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const row = receipt.data.packages[2];
    const bytes = archive(row.name, row.version);
    // Change only the gzip timestamp; the canonical package content stays identical.
    bytes.writeUInt32LE(123, 4);
    writeFileSync(row.path, bytes);
    row.tarball_sha256 = createHash('sha256').update(bytes).digest('hex');
    const profile = join(root, 'profile');
    assert.throws(() => stageCombinedProfile({ cliArchive, profile, receipt, kitManifest, tuiArchive, webArchive },
      tuiIntegrity, webDigest, cliIntegrity), /registry artifact integrity mismatch/);
    assert.equal(existsSync(profile), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('portable profile normalizes authenticated workspace tarballs across gzip metadata', () => {
  const first = fixture();
  const second = fixture();
  try {
    const peer = second.receipt.data.packages[0];
    const changed = readFileSync(peer.path);
    changed.writeUInt32LE(123, 4);
    writeFileSync(peer.path, changed);
    peer.tarball_sha256 = createHash('sha256').update(changed).digest('hex');
    const stage = (input: ReturnType<typeof fixture>) => {
      const profile = join(input.root, 'profile');
      stageCombinedProfile({ profile, receipt: input.receipt, kitManifest: input.kitManifest,
        tuiArchive: input.tuiArchive, webArchive: input.webArchive, cliArchive: input.cliArchive },
      input.tuiIntegrity, input.webDigest, input.cliIntegrity);
      return readFileSync(join(profile, 'artifacts/deepseek-ai-cordis-4.0.4.tgz'));
    };
    assert.deepEqual(stage(first), stage(second));
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test('normalized workspace tarballs ignore member order and inert manifest order', () => {
  const file = tarEntry('package/lib/client.js', Buffer.from('export const same = true;'));
  const first = gzipSync(Buffer.concat([
    tarEntry('package/package.json', Buffer.from('{"name":"@deepseek-ai/cordis","version":"4.0.4"}')),
    file, Buffer.alloc(1024),
  ]));
  const second = gzipSync(Buffer.concat([
    file, tarEntry('package/package.json', Buffer.from('{ "version": "4.0.4", "name": "@deepseek-ai/cordis" }')),
    Buffer.alloc(1024),
  ]));
  assert.equal(inspectPeerArtifact(first).artifactSha256, inspectPeerArtifact(second).artifactSha256);
  assert.deepEqual(normalizePeerArtifact(first), normalizePeerArtifact(second));
});

test('normalization preserves conditional export precedence in package manifests', () => {
  const original = archive('@deepseek-ai/cordis', '4.0.4');
  const withExports = gzipSync(Buffer.concat([
    tarEntry('package/package.json', Buffer.from(JSON.stringify({
      name: '@deepseek-ai/cordis', version: '4.0.4',
      exports: { '.': { node: './node.js', default: './fallback.js' } },
    }))), Buffer.alloc(1024),
  ]));
  const normalized = gunzipSync(normalizePeerArtifact(withExports)).toString('utf8');
  assert.match(normalized, /"node":"\.\/node\.js","default":"\.\/fallback\.js"/);
  assert.notDeepEqual(normalizePeerArtifact(withExports), normalizePeerArtifact(original));
});

test('semantic peer identity retains unknown nested manifest-map order', () => {
  const packed = (first: string, second: string) => gzipSync(Buffer.concat([
    tarEntry('package/package.json', Buffer.from(JSON.stringify({
      name: '@deepseek-ai/cordis', version: '4.0.4',
      customPolicy: { [first]: first === 'strict' ? './strict.js' : './fallback.js',
        [second]: second === 'strict' ? './strict.js' : './fallback.js' },
    }))), Buffer.alloc(1024),
  ]));
  const before = packed('strict', 'default');
  const reversed = packed('default', 'strict');
  assert.equal(inspectPeerArtifact(before).artifactSha256,
    inspectPeerArtifact(reversed).artifactSha256);
  assert.notEqual(inspectSemanticPeerArtifact(before), inspectSemanticPeerArtifact(reversed));
  const normalized = normalizePeerArtifact(before);
  assert.equal(inspectSemanticPeerArtifact(normalized), inspectSemanticPeerArtifact(before));
  assert.match(gunzipSync(normalized).toString('utf8'),
    /"strict":"\.\/strict\.js","default":"\.\/fallback\.js"/);
});

test('normalization converges package-name dependency maps without changing specs', () => {
  const packed = (reverse: boolean) => gzipSync(Buffer.concat([
    tarEntry('package/package.json', Buffer.from(JSON.stringify({
      name: '@deepseek-ai/cordis', version: '4.0.4',
      peerDependencies: reverse
        ? { beta: '^2.0.0', alpha: '^1.0.0' }
        : { alpha: '^1.0.0', beta: '^2.0.0' },
    }))), Buffer.alloc(1024),
  ]));
  const first = packed(false);
  const second = packed(true);
  assert.equal(inspectSemanticPeerArtifact(first), inspectSemanticPeerArtifact(second));
  assert.deepEqual(normalizePeerArtifact(first), normalizePeerArtifact(second));
  assert.match(gunzipSync(normalizePeerArtifact(second)).toString('utf8'),
    /"alpha":"\^1\.0\.0","beta":"\^2\.0\.0"/);
});

test('stages the native Web plugin in the same governed workbench profile', () => {
  const { cliArchive, cliIntegrity, root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const profile = join(root, 'profile');
    stageCombinedProfile({ cliArchive, profile, receipt, kitManifest, tuiArchive, webArchive }, tuiIntegrity, webDigest, cliIntegrity);
    const tuiEntry = JSON.parse(readFileSync(join(profile, 'workbench-tui/receipt.json'), 'utf8'));
    assert.equal(tuiEntry.schemaVersion, 'dsh-workbench.installed-tui-entry.v1');
    assert.equal(tuiEntry.releaseVersion, releaseVersion);
    assert.equal(tuiEntry.entry, 'scripts/launch-workbench-tui.ts');
    for (const file of tuiEntry.files) assert.equal(createHash('sha256')
      .update(readFileSync(join(profile, 'workbench-tui', file.path))).digest('hex'), file.sha256);
    assert.equal(readFileSync(join(profile, 'LICENSE'), 'utf8'),
      readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'));
    assert.equal(readFileSync(join(profile, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
      readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    assert.equal(manifest.devDependencies, undefined);
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-harness-tui/dsh-tui',
    ]);
    assert.equal(manifest.dependencies['@sympoies/dsh-workbench-web'],
      `file:artifacts/sympoies-dsh-workbench-web-${releaseVersion}.tgz`);
    // Registers the Web plugin, and keeps approvals asking when the installed launch
    // runs DSH as a full host agent (danger-full-access would otherwise imply never).
    assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'),
      "- insert:\n    - id: dsh-workbench-web\n      name: '@sympoies/dsh-workbench-web'\n"
      + '- id: approval\n  config:\n    policy: ask\n');
    assert.deepEqual(readFileSync(join(profile, `artifacts/sympoies-dsh-workbench-web-${releaseVersion}.tgz`)),
      normalizePeerArtifact(readFileSync(webArchive)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects altered Web code under the same package name and version', () => {
  const { cliArchive, cliIntegrity, root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const profile = join(root, 'profile');
    writeFileSync(webArchive, archive('@sympoies/dsh-workbench-web', releaseVersion,
      'export const marker = 2;'));
    assert.throws(() => stageCombinedProfile({ cliArchive, profile, receipt, kitManifest, tuiArchive, webArchive },
      tuiIntegrity, webDigest, cliIntegrity), /Web archive digest/);
    assert.equal(existsSync(profile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stages a portable profile from the authenticated runtime-kit patched receipt', () => {
  const { cliArchive, cliIntegrity, root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const profile = join(root, 'profile');
    stageCombinedProfile({ cliArchive, profile, receipt, kitManifest, tuiArchive, webArchive }, tuiIntegrity, webDigest, cliIntegrity);
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-harness-tui/dsh-tui',
    ]);
    assert.equal(manifest.dependencies['@sympoies/dsh-runtime-kit'], undefined);
    assert.equal(manifest.dependencies['@deepseek-ai/dsh-sandbox'],
      'file:artifacts/deepseek-ai-dsh-sandbox-0.1.7-rc.1.tgz');
    assert.equal(manifest.dependencies['@deepseek-harness-tui/dsh-tui'],
      'file:artifacts/deepseek-harness-tui-dsh-tui-0.11.0.tgz');
    const workspace = readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(workspace, /patchedDependencies:/);
    assert.match(workspace, /'@deepseek-ai\/dsh-sandbox': 'file:artifacts\/deepseek-ai-dsh-sandbox-0\.1\.7-rc\.1\.tgz'/);
    assert.deepEqual(readFileSync(join(profile, 'artifacts/deepseek-ai-dsh-sandbox-0.1.7-rc.1.tgz')),
      normalizePeerArtifact(readFileSync(receipt.data.packages[1].path)));
    assert.match(readFileSync(join(profile, 'cordis.yml'), 'utf8'), /^\[\]\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a mixed, forged, or incomplete patched closure before creating a profile', () => {
  const { cliArchive, cliIntegrity, root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const profile = join(root, 'profile');
    assert.throws(() => stageCombinedProfile({ cliArchive, profile, receipt: {
      ...receipt, data: { ...receipt.data, packages: receipt.data.packages.slice(0, 1) },
    }, kitManifest, tuiArchive, webArchive }, tuiIntegrity, webDigest, cliIntegrity), /closure/);
    assert.throws(() => stageCombinedProfile({ cliArchive, profile, receipt: {
      ...receipt, data: { ...receipt.data, patch_state: 'pristine' },
    }, kitManifest, tuiArchive, webArchive }, tuiIntegrity, webDigest, cliIntegrity), /identity/);
    assert.throws(() => stageCombinedProfile({ cliArchive, profile, receipt: {
      ...receipt, data: { ...receipt.data, packages: [
        receipt.data.packages[0],
        { ...receipt.data.packages[1], tarball_sha256: '0'.repeat(64) },
        ...receipt.data.packages.slice(2),
      ] },
    }, kitManifest, tuiArchive, webArchive }, tuiIntegrity, webDigest, cliIntegrity), /digest/);
    assert.throws(() => stageCombinedProfile({ cliArchive, profile, receipt, kitManifest: {
      ...kitManifest, patched_workspace_artifacts: {
        '@deepseek-ai/dsh-sandbox': '0'.repeat(64),
      },
    }, tuiArchive, webArchive }, tuiIntegrity, webDigest, cliIntegrity), /digest/);
    assert.throws(() => stageCombinedProfile({ cliArchive, profile, receipt, kitManifest: {
      ...kitManifest, validated_releases: { '0.1.7-rc.1': { revision: '0'.repeat(40) } },
    }, tuiArchive, webArchive }, tuiIntegrity, webDigest, cliIntegrity), /revision/);
    assert.throws(() => stageCombinedProfile({ cliArchive, profile, receipt, kitManifest, tuiArchive, webArchive },
      'sha512-' + '0'.repeat(88), undefined, cliIntegrity), /TUI archive integrity/);
    writeFileSync(webArchive, archive('@sympoies/dsh-workbench-web', '0.1.0-rc.4'));
    assert.throws(() => stageCombinedProfile({ cliArchive, profile, receipt, kitManifest, tuiArchive, webArchive },
      tuiIntegrity, webDigest, cliIntegrity), /Web archive identity/);
    assert.equal(existsSync(profile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preserves a profile directory owned by another process', () => {
  const { cliArchive, cliIntegrity, root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const profile = join(root, 'profile');
    mkdirSync(profile);
    writeFileSync(join(profile, 'owner.txt'), 'keep');
    assert.throws(() => stageCombinedProfile({ cliArchive, profile, receipt, kitManifest, tuiArchive, webArchive },
      tuiIntegrity, webDigest, cliIntegrity), /EEXIST/);
    assert.equal(readFileSync(join(profile, 'owner.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires an absolute DSH home with a profiles directory', () => {
  const { cliArchive, cliIntegrity, root, receipt, tuiArchive, webArchive } = fixture();
  try {
    assert.throws(() => stageCombinedProfileFromPinnedKit({ cliArchive,
      dshHome: 'relative-home', receipt, tuiArchive, webArchive, kitRepo: root,
    }), /DSH home/);
    assert.throws(() => stageCombinedProfileFromPinnedKit({ cliArchive,
      dshHome: root, receipt, tuiArchive, webArchive, kitRepo: root,
    }), /profiles directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('roots the authenticated official CLI in the same profile graph', () => {
  const { cliArchive, cliIntegrity, root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const profile = join(root, 'profile');
    const input = { profile, receipt, kitManifest, tuiArchive, webArchive, cliArchive };
    stageCombinedProfile(input, tuiIntegrity, webDigest, cliIntegrity);
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies['@deepseek-ai/dsh'], 'file:artifacts/deepseek-ai-dsh-0.1.7-rc.1.tgz');
    assert.deepEqual(readFileSync(join(profile, 'artifacts/deepseek-ai-dsh-0.1.7-rc.1.tgz')), readFileSync(cliArchive));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects a changed or misidentified official CLI before creating the profile', () => {
  const { cliArchive, cliIntegrity, root, receipt, kitManifest, tuiArchive, tuiIntegrity, webArchive, webDigest } = fixture();
  try {
    const profile = join(root, 'profile');
    const input = { profile, receipt, kitManifest, tuiArchive, webArchive, cliArchive };
    writeFileSync(cliArchive, archive('@deepseek-ai/dsh', '0.1.7-rc.1', 'altered'));
    assert.throws(() => stageCombinedProfile(input, tuiIntegrity, webDigest, cliIntegrity), /Official CLI archive integrity mismatch/);
    assert.equal(existsSync(profile), false);
    for (const [name, version] of [['@deepseek-ai/other', '0.1.7-rc.1'], ['@deepseek-ai/dsh', '0.1.7-rc.2']]) {
      const bytes = archive(name, version);
      writeFileSync(cliArchive, bytes);
      const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
      assert.throws(() => stageCombinedProfile(input, tuiIntegrity, webDigest, integrity), /Official CLI archive identity mismatch/);
      assert.equal(existsSync(profile), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
