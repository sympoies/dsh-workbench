import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { WorkbenchContract } from '../src/contract-types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts/contract.mjs');
const source = join(root, 'compatibility/workbench.json');
const webArtifactSource = join(root, 'compatibility/web-artifact.json');
const linuxArtifactSource = join(root, 'compatibility/linux-artifacts.json');

function fixture(change?: (contract: WorkbenchContract) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-contract-'));
  const compatibility = join(dir, 'compatibility');
  mkdirSync(join(compatibility, 'patches'), { recursive: true });
  const path = join(compatibility, 'workbench.json');
  const contract = JSON.parse(readFileSync(source, 'utf8')) as WorkbenchContract;
  // Synthetic accepted contract for schema tests while the source may be a candidate.
  accept(contract);
  change?.(contract);
  writeFileSync(path, JSON.stringify(contract));
  const webArtifact = JSON.parse(readFileSync(webArtifactSource, 'utf8')) as { releaseVersion: string };
  webArtifact.releaseVersion = contract.release.version;
  writeFileSync(join(compatibility, 'web-artifact.json'), JSON.stringify(webArtifact));
  const linuxArtifact = JSON.parse(readFileSync(linuxArtifactSource, 'utf8')) as { releaseVersion: string };
  linuxArtifact.releaseVersion = contract.release.version;
  writeFileSync(join(compatibility, 'linux-artifacts.json'), JSON.stringify(linuxArtifact));
  copyFileSync(join(root, 'compatibility/patches/tui-rename.patch'), join(compatibility, 'patches/tui-rename.patch'));
  return { dir, path };
}

function accept(contract: WorkbenchContract) {
  contract.status = 'accepted';
  for (const component of Object.values(contract.components)) component.status = 'accepted';
  Object.entries(contract.acceptance).forEach(([name, gate], gateIndex) => {
    gate.status = 'passed';
    gate.evidence = contract.runtime.platforms.map((platform, platformIndex) => ({
      platform,
      url: `https://github.com/sympoies/dsh-workbench/pull/${100 + gateIndex * 10 + platformIndex}`,
    }));
  });
}

function run(command: string, path: string, extra: string[] = []) {
  return spawnSync(process.execPath, [script, command, '--contract', path, ...extra], {
    encoding: 'utf8',
  });
}

test('current Linux contract is valid and only an accepted fixture can be activated', () => {
  const check = run('check', source);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, 'Contract valid.\n');
  assert.equal(check.stderr, '');
  const printed = run('print', source);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, `${JSON.stringify(JSON.parse(readFileSync(source, 'utf8')))}\n`);
  assert.equal(printed.stderr, '');
  const { dir, path } = fixture();
  try {
    const activation = run('require-accepted', path);
    assert.equal(activation.status, 0, activation.stderr);
    const current = JSON.parse(readFileSync(source, 'utf8')) as WorkbenchContract;
    const currentActivation = run('require-accepted', source);
    assert.equal(currentActivation.status === 0, current.status === 'accepted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a candidate contract cannot be activated', () => {
  const { dir, path } = fixture(contract => {
    contract.status = 'candidate';
    for (const component of Object.values(contract.components)) component.status = 'candidate';
    for (const gate of Object.values(contract.acceptance)) {
      gate.status = 'pending';
      gate.evidence = [];
    }
  });
  try {
    assert.equal(run('check', path).status, 0);
    const activation = run('require-accepted', path);
    assert.notEqual(activation.status, 0);
    assert.match(activation.stderr, /candidate/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('first release targets Linux x64 while macOS remains a later version', () => {
  const contract = JSON.parse(readFileSync(source, 'utf8')) as WorkbenchContract;
  assert.deepEqual(contract.runtime.platforms, ['linux-x64']);
});

test('pins have immutable source and integrity identities', () => {
  const { dir, path } = fixture(contract => {
    contract.components.dsh.source.commit = 'main';
  });
  try {
    const result = run('check', path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /commit/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release identity changes whenever the component tuple changes', () => {
  const { dir, path } = fixture(contract => {
    contract.components.tui.source.commit = 'a'.repeat(40);
  });
  try {
    const result = run('compare', path, ['--previous', source]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /component tuple changed without a new Workbench release\.version/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changed Web artifact digest requires a new Workbench release version', () => {
  const previous = fixture();
  const current = fixture();
  try {
    const recordPath = join(current.dir, 'compatibility/web-artifact.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { artifactSha256: string };
    record.artifactSha256 = 'a'.repeat(64);
    writeFileSync(recordPath, JSON.stringify(record));
    assert.match(run('compare', current.path, ['--previous', previous.path]).stderr,
      /component tuple changed without a new Workbench release\.version/i);
  } finally {
    rmSync(previous.dir, { recursive: true, force: true });
    rmSync(current.dir, { recursive: true, force: true });
  }
});

test('changed reviewed Linux package or lock identity requires a new release version', () => {
  const previous = fixture();
  const current = fixture();
  try {
    const path = join(current.dir, 'compatibility/linux-artifacts.json');
    const record = JSON.parse(readFileSync(path, 'utf8')) as { profileLockRawSha256: string };
    record.profileLockRawSha256 = 'a'.repeat(64);
    writeFileSync(path, JSON.stringify(record));
    assert.match(run('compare', current.path, ['--previous', previous.path]).stderr,
      /component tuple changed without a new Workbench release\.version/i);
  } finally {
    rmSync(previous.dir, { recursive: true, force: true });
    rmSync(current.dir, { recursive: true, force: true });
  }
});

test('adding a Web artifact record to a previous release requires a version bump', () => {
  const previous = fixture();
  const current = fixture();
  try {
    rmSync(join(previous.dir, 'compatibility/web-artifact.json'));
    assert.match(run('compare', current.path, ['--previous', previous.path]).stderr,
      /component tuple changed without a new Workbench release\.version/i);
  } finally {
    rmSync(previous.dir, { recursive: true, force: true });
    rmSync(current.dir, { recursive: true, force: true });
  }
});

test('schema 4 compares with the original schema 1 candidate only after a release bump', () => {
  const previous = fixture(contract => {
    contract.schemaVersion = 1;
    Reflect.deleteProperty(contract.components, 'codexSubscription');
    contract.release.version = '0.1.0-rc.0';
    contract.release.tag = 'v0.1.0-rc.0';
    Reflect.deleteProperty(contract.runtime, 'pnpm');
    Reflect.deleteProperty(contract.components.tui, 'peerOverrides');
    Reflect.deleteProperty(contract.components.tui, 'compatibilityPatch');
  });
  try {
    assert.equal(run('compare', source, ['--previous', previous.path]).status, 0);
    const unchanged = fixture(contract => {
      contract.release.version = '0.1.0-rc.0';
      contract.release.tag = 'v0.1.0-rc.0';
    });
    try {
      assert.match(run('compare', unchanged.path, ['--previous', previous.path]).stderr, /component tuple changed without a new Workbench release.version/i);
    } finally {
      rmSync(unchanged.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(previous.dir, { recursive: true, force: true });
  }
});

test('schema 4 compares with the prior unpatched schema 2 contract', () => {
  const previous = fixture(contract => {
    contract.schemaVersion = 2;
    Reflect.deleteProperty(contract.components, 'codexSubscription');
    contract.release.version = '0.1.0-rc.2';
    contract.release.tag = 'v0.1.0-rc.2';
    Reflect.deleteProperty(contract.components.tui, 'compatibilityPatch');
  });
  try {
    assert.equal(run('compare', source, ['--previous', previous.path]).status, 0);
  } finally {
    rmSync(previous.dir, { recursive: true, force: true });
  }
});

test('TUI compatibility patch must match its reviewed digest and path', () => {
  for (const change of ([
    (contract: WorkbenchContract) => { contract.components.tui.compatibilityPatch!.sha256 = 'a'.repeat(64); },
    (contract: WorkbenchContract) => { contract.components.tui.compatibilityPatch!.path = 'patches/unknown.patch'; },
  ])) {
    const { dir, path } = fixture(change);
    try {
      assert.notEqual(run('check', path).status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a copied contract rejects a changed or missing patch in its own tree', () => {
  const copied = fixture();
  try {
    assert.equal(run('check', copied.path).status, 0);
    writeFileSync(join(copied.dir, 'compatibility/patches/tui-rename.patch'), 'changed patch\n');
    assert.match(run('check', copied.path).stderr, /patch digest mismatch/i);
    rmSync(join(copied.dir, 'compatibility/patches/tui-rename.patch'));
    assert.match(run('check', copied.path).stderr, /patch cannot be read/i);
  } finally {
    rmSync(copied.dir, { recursive: true, force: true });
  }
});

test('platform and toolchain changes require a new Workbench version', () => {
  for (const change of ([
    contract => {
      contract.runtime.platforms = ['darwin-arm64'];
      for (const gate of Object.values(contract.acceptance)) {
        gate.evidence[0].platform = 'darwin-arm64';
      }
    },
    contract => { contract.runtime.pnpm = '11.25.0'; },
    contract => { contract.components.tui.toolchain.pnpm = '11.22.0'; },
    contract => { contract.components.tui.peerOverrides!.react = '19.2.0'; },
  ] satisfies Array<(contract: WorkbenchContract) => void>)) {
    const { dir, path } = fixture(change);
    try {
      assert.match(run('compare', path, ['--previous', source]).stderr, /component tuple changed without a new Workbench release\.version/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('runtime Node baseline cannot fall below the pinned runtime-kit requirement', () => {
  const lower = fixture(contract => { contract.runtime.node = '>=23.0.0'; });
  const higher = fixture(contract => { contract.runtime.node = '>=25.0.0'; });
  try {
    assert.match(run('check', lower.path).stderr, /runtime\.node.*runtimeKit/i);
    assert.equal(run('check', higher.path).status, 0);
  } finally {
    rmSync(lower.dir, { recursive: true, force: true });
    rmSync(higher.dir, { recursive: true, force: true });
  }
});

test('a product-only release can advance the Workbench version', () => {
  const { dir, path } = fixture(contract => {
    const match = /^(.*-rc\.)(\d+)$/.exec(contract.release.version);
    contract.release.version = match ? `${match[1]}${Number(match[2]) + 1}`
      : contract.release.version.replace(/\.(\d+)$/, (_, patch: string) => `.${Number(patch) + 1}`);
    contract.release.tag = `v${contract.release.version}`;
  });
  try {
    assert.equal(run('compare', path, ['--previous', source]).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a new release version must move forward', () => {
  const { dir, path } = fixture(contract => {
    contract.release.version = '0.0.9';
    contract.release.tag = 'v0.0.9';
    contract.components.tui.source.commit = 'a'.repeat(40);
  });
  try {
    assert.match(run('compare', path, ['--previous', source]).stderr, /new Workbench release.version must advance/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accepted contract needs recorded validation for every gate', () => {
  const { dir, path } = fixture(contract => {
    contract.acceptance.web.evidence = [];
  });
  try {
    const result = run('check', path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /acceptance/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accepted contract refuses each missing component or gate verdict', () => {
  for (const component of ['dsh', 'runtimeKit', 'tui'] as const) {
    const { dir, path } = fixture(contract => { contract.components[component].status = 'candidate'; });
    try {
      assert.match(run('require-accepted', path).stderr, /accepted contract requires accepted components/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const gate of ['runtimeKit', 'tui', 'web', 'handoff'] as const) {
    const { dir, path } = fixture(contract => { contract.acceptance[gate].status = 'pending'; });
    try {
      assert.match(run('require-accepted', path).stderr, /accepted contract requires accepted components/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('an accepted release cannot be downgraded under its existing version', () => {
  const previous = fixture(accept);
  const current = fixture(contract => {
    contract.status = 'candidate';
  });
  try {
    assert.match(run('compare', current.path, ['--previous', previous.path]).stderr, /accepted release contract is immutable/i);
  } finally {
    rmSync(previous.dir, { recursive: true, force: true });
    rmSync(current.dir, { recursive: true, force: true });
  }
});

test('accepted release evidence must identify each gate and platform with distinct public records', () => {
  for (const change of ([
    contract => { contract.acceptance.web.evidence[0].url = 'https://github.com/'; },
    contract => { contract.acceptance.web.evidence[0].url = contract.acceptance.tui.evidence[0].url; },
    contract => { contract.acceptance.web.evidence.pop(); },
  ] satisfies Array<(contract: WorkbenchContract) => void>)) {
    const { dir, path } = fixture(contract => {
      accept(contract);
      change(contract);
    });
    try {
      const result = run('require-accepted', path);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /acceptance/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('schema 4 pins the Codex subscription provider as an exact component', () => {
  const current = JSON.parse(readFileSync(source, 'utf8')) as WorkbenchContract;
  assert.equal(current.schemaVersion, 4);
  assert.equal(current.components.codexSubscription.package.name, '@sympoies/dsh-llm-codex-subscription');
  assert.equal(current.components.codexSubscription.source.tag,
    `dsh-llm-codex-subscription-v${current.components.codexSubscription.package.version}`);
  for (const [change, message] of [
    [(contract: WorkbenchContract) => { contract.components.codexSubscription.package.name = '@sympoies/other-provider'; },
      /codexSubscription package name is not the reviewed provider/],
    [(contract: WorkbenchContract) => { contract.components.codexSubscription.source.tag = 'v0.2.0'; },
      /codexSubscription source tag and package version disagree/],
    [(contract: WorkbenchContract) => { contract.components.codexSubscription.package.integrity = 'sha512-short'; },
      /codexSubscription\.package\.integrity has an invalid value/],
    [(contract: WorkbenchContract) => { contract.components.codexSubscription.source.commit = 'main'; },
      /codexSubscription\.source\.commit has an invalid value/],
    [(contract: WorkbenchContract) => { contract.components.codexSubscription.toolchain.pnpm = '11.0.0'; },
      /components\.codexSubscription|codexSubscription\.toolchain has missing or unexpected fields/],
    [(contract: WorkbenchContract) => { Reflect.deleteProperty(contract.components, 'codexSubscription'); },
      /components has missing or unexpected fields/],
    [(contract: WorkbenchContract) => { contract.components.codexSubscription.status = 'candidate'; },
      /accepted contract requires accepted components/],
  ] as const) {
    const { dir, path } = fixture(change);
    try {
      const result = run('check', path);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const base = fixture();
  const repinned = fixture(contract => {
    contract.components.codexSubscription.package.integrity = `sha512-${'A'.repeat(86)}==`;
  });
  try {
    const result = run('compare', repinned.path, ['--previous', base.path]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /component tuple changed without a new Workbench release\.version/);
  } finally {
    rmSync(base.dir, { recursive: true, force: true });
    rmSync(repinned.dir, { recursive: true, force: true });
  }
});

test('schema 4 compares with the prior schema 3 contract only after a release bump', () => {
  const schema3 = (version: string) => fixture(contract => {
    contract.schemaVersion = 3;
    contract.release.version = version;
    contract.release.tag = `v${version}`;
    Reflect.deleteProperty(contract.components, 'codexSubscription');
  });
  const previous = schema3('0.2.1');
  try {
    assert.equal(run('compare', source, ['--previous', previous.path]).status, 0);
    // A schema 3 contract is readable only as the previous side of a comparison.
    assert.match(run('check', previous.path).stderr, /unsupported contract schemaVersion/);
    const current = JSON.parse(readFileSync(source, 'utf8')) as WorkbenchContract;
    const same = schema3(current.release.version);
    try {
      assert.match(run('compare', source, ['--previous', same.path]).stderr,
        /component tuple changed without a new Workbench release\.version|accepted release contract is immutable/);
    } finally { rmSync(same.dir, { recursive: true, force: true }); }
  } finally { rmSync(previous.dir, { recursive: true, force: true }); }
});
