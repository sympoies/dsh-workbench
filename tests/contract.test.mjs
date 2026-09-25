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
    contract.components.tui.package.version = '0.11.1';
  });
  try {
    const result = run('compare', path, ['--previous', source]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /version/i);
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
    contract.status = 'accepted';
    for (const component of Object.values(contract.components)) component.status = 'accepted';
    for (const gate of Object.values(contract.acceptance)) {
      gate.status = 'passed';
      gate.evidence = ['https://github.com/sympoies/dsh-workbench/issues/6'];
    }
  });
  try {
    const result = run('require-accepted', path);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
