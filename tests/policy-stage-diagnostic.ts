import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const profile = process.argv[2];
assert.ok(profile && isAbsolute(profile), 'A disposable absolute profile path is required');
const packageRoot = realpathSync(join(profile, 'node_modules', '@sympoies', 'dsh-runtime-kit'));

const marker = `
import { appendFileSync as workbenchAppendStage } from 'node:fs';
function workbenchPolicyStage(stage) {
  const path = process.env.WORKBENCH_POLICY_TRACE;
  if (path) workbenchAppendStage(path, stage + '\\n');
}
`;

function instrument(file: string, stages: ReadonlyArray<readonly [string, string]>): void {
  const path = join(packageRoot, file);
  let source = readFileSync(path, 'utf8');
  for (const [statement, stage] of stages) {
    assert.equal(source.split(statement).length, 2, `${file}: ${stage} must occur exactly once`);
    source = source.replace(statement,
      `workbenchPolicyStage('${stage}:before');\n${statement}\nworkbenchPolicyStage('${stage}:after');`);
  }
  writeFileSync(path, marker + source);
}

instrument('dist/src/policy/index.js', [
  ['prerequisiteProof = await prerequisites.begin(exec, correlation.context);', 'prerequisite'],
  ['finishProbe = await finishLine.probe(exec, correlation.context);', 'finish-probe'],
  ['decision = await transport.evaluate(exec, correlation.context, prerequisiteProof);', 'policy'],
  ['acceptanceReservation = await acceptance.admit(exec, correlation.context);', 'acceptance'],
  ['const finishReservation = await finishLine.begin(exec, correlation.context);', 'finish-begin'],
]);
instrument('dist/src/workspace-lease/index.js', [
  ['const downstream = await next();', 'lease-downstream'],
  ['const targets = await this.#resolutionFor(exec, provider, slot, identity, admissionSignal.signal);',
    'lease-targets'],
  ['const granted = await this.#begin(binding, target, slot.session.header.cwd, identity, admissionSignal.signal);',
    'lease-begin'],
]);
console.log('Installed disposable profile has stage-only diagnostic instrumentation');
