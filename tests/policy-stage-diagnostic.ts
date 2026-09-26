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

function instrument(file: string, stages: ReadonlyArray<readonly [string, string, 'before' | 'around'?]>): void {
  const path = join(packageRoot, file);
  let source = readFileSync(path, 'utf8');
  for (const [statement, stage, placement] of stages) {
    assert.equal(source.split(statement).length, 2, `${file}: ${stage} must occur exactly once`);
    source = source.replace(statement,
      placement === 'before'
        ? `workbenchPolicyStage('${stage}:before');\n${statement}`
        : `workbenchPolicyStage('${stage}:before');\n${statement}\nworkbenchPolicyStage('${stage}:after');`);
  }
  writeFileSync(path, marker + source);
}

instrument('dist/src/policy/index.js', [
  ['prerequisiteProof = await prerequisites.begin(exec, correlation.context);', 'prerequisite'],
  ['finishProbe = await finishLine.probe(exec, correlation.context);', 'finish-probe'],
  ['decision = await transport.evaluate(exec, correlation.context, prerequisiteProof);', 'policy'],
  ['acceptanceReservation = await acceptance.admit(exec, correlation.context);', 'acceptance'],
  ['const finishReservation = await finishLine.begin(exec, correlation.context);', 'finish-begin'],
  ['const routed = await finishLine.execute(exec);', 'policy-execute'],
]);
instrument('dist/src/workspace-lease/index.js', [
  ['const downstream = await next();', 'lease-downstream'],
  ['const targets = await this.#resolutionFor(exec, provider, slot, identity, admissionSignal.signal);',
    'lease-targets'],
  ['if (targets.length === 0) {', 'lease-empty-targets'],
  ['const authorization = this.#authorizations.get(exec);', 'lease-guard'],
  ['await owner.draining;', 'lease-owner-drain'],
  ['const anchor = owner.anchor ?? this.#startAnchor(owner);', 'lease-anchor-start'],
  ['await anchor.catch(() => { });', 'lease-anchor-wait'],
  ['const existing = owner.bindings.get(key);', 'lease-existing'],
  ['const inflight = owner.acquisitions.get(key);', 'lease-inflight'],
  ['return await acquisition;', 'lease-acquisition'],
  ['const granted = await this.#begin(binding, target, slot.session.header.cwd, identity, admissionSignal.signal);',
    'lease-begin'],
]);
instrument('dist/src/finish-line/index.js', [
  ['const registration = editRegistrations.get(exec);', 'finish-execute-entry'],
  ['const prepared = pending.prepared;', 'finish-validation-ready'],
  ['let operationId = pending.operationId;', 'finish-validation-probe'],
  ['if (!await ensureRunnerCapability(ledger, prepared.identity, exec.signal, operation.command)) {',
    'finish-capability'],
  ['const probe = await client.run({', 'finish-run-probe', 'before'],
  ['const runtime = await prepareValidationRuntime(exec, {', 'finish-runtime', 'before'],
]);
instrument('dist/src/finish-line/nils-client.js', [
  ['executionLease = authenticatedExecution.acquire(operation.controller.signal);', 'nils-acquire'],
  ['const argv = await resolveSubprocessArgv(ctx, agentHook.argv([\'finish-line\', action, \'--format\', \'json\']), executionSignal);',
    'nils-argv'],
  ['operation.handle = executionLease.spawn({', 'nils-spawn', 'before'],
  ['const first = await Promise.race([', 'nils-wait', 'before'],
]);
console.log('Installed disposable profile has stage-only diagnostic instrumentation');
