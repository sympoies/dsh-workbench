import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('manual combined-profile runs are restricted to the default branch', () => {
  const workflow = readFileSync(new URL('../.github/workflows/combined-profile.yml', import.meta.url), 'utf8');
  assert.match(workflow,
    /^  authenticated-profile:\n    if: github\.event_name != 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/main'$/m);
});
