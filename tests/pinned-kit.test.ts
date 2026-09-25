import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readPinnedKitJson } from '../src/pinned-kit.ts';

const contract = JSON.parse(readFileSync(new URL('../compatibility/workbench.json', import.meta.url), 'utf8'));

test('pinned kit reads disable replacement refs and reject a different tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-workbench-pinned-kit-'));
  const git = join(root, 'git');
  mkdirSync(join(root, 'repo'));
  writeFileSync(git, `#!/bin/sh
[ "$GIT_NO_REPLACE_OBJECTS" = 1 ] || exit 7
[ -z "$GIT_DIR" ] && [ -z "$GIT_CONFIG_COUNT" ] || exit 8
case "$1" in
  rev-parse)
    if [ "$WRONG_TREE" = 1 ]; then printf '%040d\\n' 0; else
      printf '%s\\n' '${contract.components.runtimeKit.source.tree}'; fi ;;
  show) printf '%s\\n' '{"repository":"pinned"}' ;;
  *) exit 9 ;;
esac
`);
  chmodSync(git, 0o755);
  const oldDir = process.env.GIT_DIR;
  const oldConfig = process.env.GIT_CONFIG_COUNT;
  try {
    process.env.GIT_DIR = join(root, 'other');
    process.env.GIT_CONFIG_COUNT = '1';
    assert.equal((readPinnedKitJson(join(root, 'repo'), 'compatibility/dsh.json', git) as
      { repository: string }).repository, 'pinned');
    process.env.WRONG_TREE = '1';
    assert.throws(() => readPinnedKitJson(join(root, 'repo'), 'compatibility/dsh.json', git), /tree/);
  } finally {
    if (oldDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = oldDir;
    if (oldConfig === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = oldConfig;
    delete process.env.WRONG_TREE;
    rmSync(root, { recursive: true, force: true });
  }
});
