// Hidden verifier for the inventory-report task: runs the repository's own tests, then
// exercises the delivered CLI against the task's behavior. Usage: node verify.mjs CHECKOUT
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const checkout = process.argv[2];
if (!checkout) throw new Error('usage: node verify.mjs CHECKOUT');
const failures = [];
const check = (name, body) => {
  try { body(); console.log(`ok   ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error.message}`); }
};

const tests = spawnSync('npm', ['test'], { cwd: checkout, encoding: 'utf8', timeout: 300_000 });
check('repository tests pass', () => assert.equal(tests.status, 0, `${tests.stdout}${tests.stderr}`.slice(-2000)));

const root = mkdtempSync(join(tmpdir(), 'inv-verify-'));
const file = join(root, 'stock.json');
const cli = (...args) => spawnSync(process.execPath, [join(checkout, 'src/cli.js'), '--file', file, ...args],
  { encoding: 'utf8', timeout: 30_000 });
try {
  check('empty inventory text report', () => {
    const result = cli('report');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'SKUs: 0\nUnits: 0\nValue: 0.00\n');
  });
  check('empty inventory JSON report', () => {
    const result = cli('report', '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { skus: 0, units: 0, valueCents: 0, top: [] });
  });
  for (const [sku, name, quantity, price] of [
    ['A-1', 'Anchor', '3', '12.50'], ['B-2', 'Bolt', '100', '0.25'], ['C-3', 'Chain', '2', '12.50'],
    ['D-4', 'Drill', '1', '37.50'], ['E-5', 'Eyelet', '40', '0.05'],
  ]) {
    const added = cli('add', sku, name, quantity, price);
    assert.equal(added.status, 0, added.stderr);
  }
  // Values: A-1 37.50, B-2 25.00, C-3 25.00, D-4 37.50, E-5 2.00; total 127.00, units 146.
  check('text report with ties', () => {
    const result = cli('report');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'SKUs: 5\nUnits: 146\nValue: 127.00\nTop items:\n'
      + 'A-1\tAnchor\t37.50\nD-4\tDrill\t37.50\nB-2\tBolt\t25.00\n');
  });
  check('JSON report', () => {
    const result = cli('report', '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { skus: 5, units: 146, valueCents: 12700, top: [
      { sku: 'A-1', name: 'Anchor', valueCents: 3750 }, { sku: 'D-4', name: 'Drill', valueCents: 3750 },
      { sku: 'B-2', name: 'Bolt', valueCents: 2500 }] });
  });
  check('text low-stock section', () => {
    const result = cli('report', '--low-stock', '3');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.endsWith('Low stock:\nD-4\t1\nC-3\t2\n'), result.stdout);
  });
  check('low-stock heading with no match, flags in any order', () => {
    const result = cli('report', '--low-stock', '1', '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).lowStock, []);
    const text = cli('report', '--low-stock', '0');
    assert.ok(text.stdout.endsWith('Low stock:\n'), text.stdout);
  });
  check('JSON low-stock array', () => {
    const result = cli('report', '--json', '--low-stock', '41');
    assert.deepEqual(JSON.parse(result.stdout).lowStock, [
      { sku: 'D-4', quantity: 1 }, { sku: 'C-3', quantity: 2 }, { sku: 'A-1', quantity: 3 },
      { sku: 'E-5', quantity: 40 }]);
  });
  check('invalid report arguments fail with exit 1', () => {
    for (const args of [['--low-stock'], ['--low-stock', '-1'], ['--low-stock', '2.5'], ['--low-stock', 'x'], ['--verbose']]) {
      const result = cli('report', ...args);
      assert.equal(result.status, 1, `report ${args.join(' ')} exited ${result.status}`);
      assert.ok(result.stderr.trim(), `report ${args.join(' ')} printed no error`);
    }
  });
  check('existing list output unchanged', () => {
    const result = cli('list');
    assert.equal(result.stdout.split('\n')[0], 'A-1\tAnchor\t3\t12.50');
  });
  check('README documents the report subcommand', () => {
    assert.match(readFileSync(join(checkout, 'README.md'), 'utf8'), /report/);
  });
} finally { rmSync(root, { recursive: true, force: true }); }

console.log(JSON.stringify({ result: failures.length ? 'fail' : 'pass', failures }));
process.exitCode = failures.length ? 1 : 0;
