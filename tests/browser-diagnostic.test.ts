import assert from 'node:assert/strict';
import test from 'node:test';
import { publicBrowserFailure } from '../src/browser-diagnostic.ts';

test('browser navigation failures omit the Host launch token and mock key', () => {
  const token = 'a'.repeat(43);
  const key = 'mock-secret-key';
  const url = `http://127.0.0.1:4123/?token=${token}`;
  const diagnostic = publicBrowserFailure(new Error(`Navigation failed at ${url}; key=${key}`), [key]);
  assert.ok(diagnostic.includes('token=[redacted]'));
  assert.ok(!diagnostic.includes(token));
  assert.ok(!diagnostic.includes(key));
  assert.ok(!diagnostic.includes(url));
  assert.equal(JSON.parse(diagnostic).result, 'fail');
});
