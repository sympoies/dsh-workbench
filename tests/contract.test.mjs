import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const script = join(root, 'scripts/contract.mjs');
const source = join(root, 'compatibility/workbench.json');

function fixture(change) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workbench-contract-'));
  const path = join(dir, 'workbench.json');
  const contract = JSON.parse(readFileSync(source, 'utf8'));
  change?.(contract);
  writeFileSync(path, JSON.stringify(contract));
  return { dir, path };
}

function accept(contract) {
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

function run(command, path, extra = []) {
  return spawnSync(process.execPath, [script, command, '--contract', path, ...extra], {
    encoding: 'utf8',
  });
}

test('candidate contract is valid but cannot be activated', () => {
  const check = run('check', source);
  assert.equal(check.status, 0, check.stderr);
  const activation = run('require-accepted', source);
  assert.notEqual(activation.status, 0);
  assert.match(activation.stderr, /candidate/i);
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

test('schema 2 compares with the original schema 1 candidate only after a release bump', () => {
  const previous = fixture(contract => {
    contract.schemaVersion = 1;
    contract.release.version = '0.1.0-rc.0';
    contract.release.tag = 'v0.1.0-rc.0';
    delete contract.runtime.pnpm;
    delete contract.components.tui.peerOverrides;
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

test('platform and toolchain changes require a new Workbench version', () => {
  for (const change of [
    contract => contract.runtime.platforms.pop(),
    contract => { contract.runtime.pnpm = '11.25.0'; },
    contract => { contract.components.tui.toolchain.pnpm = '11.22.0'; },
    contract => { contract.components.tui.peerOverrides.react = '19.2.0'; },
  ]) {
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
    contract.release.version = '0.1.0-rc.2';
    contract.release.tag = 'v0.1.0-rc.2';
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
    contract.status = 'accepted';
  });
  try {
    const result = run('check', path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /acceptance/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accepted contract passes only after all component and gate evidence is recorded', () => {
  const { dir, path } = fixture(contract => {
    accept(contract);
  });
  try {
    const result = run('require-accepted', path);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an accepted release cannot be downgraded under its existing version', () => {
  const previous = fixture(accept);
  const current = fixture(contract => {
    contract.acceptance.web.evidence = [];
  });
  try {
    assert.match(run('compare', current.path, ['--previous', previous.path]).stderr, /accepted release contract is immutable/i);
  } finally {
    rmSync(previous.dir, { recursive: true, force: true });
    rmSync(current.dir, { recursive: true, force: true });
  }
});

test('accepted release evidence must identify each gate and platform with distinct public records', () => {
  for (const change of [
    contract => { contract.acceptance.web.evidence[0].url = 'https://github.com/'; },
    contract => { contract.acceptance.web.evidence[0].url = contract.acceptance.tui.evidence[0].url; },
    contract => { contract.acceptance.web.evidence.pop(); },
  ]) {
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
