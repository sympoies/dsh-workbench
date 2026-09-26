import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const profile = process.argv[2];
assert.ok(profile && isAbsolute(profile), 'A disposable absolute profile path is required');
const packageRoot = realpathSync(join(profile, 'node_modules', '@sympoies', 'dsh-runtime-kit'));
const tuiRoot = realpathSync(join(profile, '..', 'dsh-tui', 'node_modules',
  '@deepseek-harness-tui', 'dsh-tui', 'lib', 'types'));

const marker = `
import { appendFileSync as workbenchAppendStage } from 'node:fs';
function workbenchPolicyStage(stage) {
  const path = process.env.WORKBENCH_POLICY_TRACE;
  if (path) workbenchAppendStage(path, stage + '\\n');
}
`;

function instrument(root: string, file: string,
  stages: ReadonlyArray<readonly [string, string, ('before' | 'around')?]>): void {
  const path = join(root, file);
  let source = readFileSync(path, 'utf8');
  for (const [statement, stage, placement] of stages) {
    assert.equal(source.split(statement).length, 2, `${file}: ${stage} must occur exactly once`);
    const before = stage.startsWith('nils-')
      ? `workbenchPolicyStage('${stage}:' + action + ':before');`
      : `workbenchPolicyStage('${stage}:before');`;
    const after = stage.startsWith('nils-')
      ? `workbenchPolicyStage('${stage}:' + action + ':after');`
      : `workbenchPolicyStage('${stage}:after');`;
    source = source.replace(statement,
      placement === 'before'
        ? `${before}\n${statement}`
        : `${before}\n${statement}\n${after}`);
  }
  writeFileSync(path, marker + source);
}

instrument(packageRoot, 'dist/src/policy/index.js', [
  ['prerequisiteProof = await prerequisites.begin(exec, correlation.context);', 'prerequisite'],
  ['finishProbe = await finishLine.probe(exec, correlation.context);', 'finish-probe'],
  ['decision = await transport.evaluate(exec, correlation.context, prerequisiteProof);', 'policy'],
  ['acceptanceReservation = await acceptance.admit(exec, correlation.context);', 'acceptance'],
  ['const finishReservation = await finishLine.begin(exec, correlation.context);', 'finish-begin'],
  ['const routed = await finishLine.execute(exec);', 'policy-execute'],
  ['if (!await ctx.sessions.flush(session)) {', 'validation-session-flush', 'before'],
  ['const shell = (ctx.get(\'shell\'));', 'validation-session-flush-complete', 'before'],
  ['const escalation = normalizeSandboxEscalationRequest({', 'validation-escalation', 'before'],
  ['const approvedMode = await approveEscalation({', 'validation-approval', 'before'],
  ['policy = { ...policy, mode: approvedMode };', 'validation-approval-returned', 'before'],
  ['const headerCwd = session.header.cwd;', 'validation-header-cwd', 'before'],
  ['const spec = resolveFinishLineShellSpec(shell, operation, {', 'validation-shell-spec', 'before'],
]);
instrument(packageRoot, 'dist/src/workspace-lease/index.js', [
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
instrument(packageRoot, 'dist/src/finish-line/index.js', [
  ['const registration = editRegistrations.get(exec);', 'finish-execute-entry'],
  ['const prepared = pending.prepared;', 'finish-validation-ready'],
  ['let operationId = pending.operationId;', 'finish-validation-probe'],
  ['if (!await ensureRunnerCapability(ledger, prepared.identity, exec.signal, operation.command)) {',
    'finish-capability'],
  ['const probe = await client.run({', 'finish-run-probe', 'before'],
  ['const runtime = await prepareValidationRuntime(exec, {', 'finish-runtime', 'before'],
]);
instrument(packageRoot, 'dist/src/finish-line/nils-client.js', [
  ['executionLease = authenticatedExecution.acquire(operation.controller.signal);', 'nils-acquire'],
  ['const argv = await resolveSubprocessArgv(ctx, agentHook.argv([\'finish-line\', action, \'--format\', \'json\']), executionSignal);',
    'nils-argv'],
  ['operation.handle = executionLease.spawn({', 'nils-spawn', 'before'],
  ['const handle = operation.handle;', 'nils-spawn-after', 'before'],
  ['const first = await Promise.race([', 'nils-wait', 'before'],
]);
const tuiPluginPath = join(tuiRoot, 'dsh-adapter/plugin.js');
let tuiPlugin = readFileSync(tuiPluginPath, 'utf8');
const tuiApprovalHandler = "ctx.on('approval/request', (req, next) => approvalStore.park(req).catch(() => next()));";
assert.equal(tuiPlugin.split(tuiApprovalHandler).length, 2, 'TUI approval handler must occur exactly once');
tuiPlugin = tuiPlugin.replace(tuiApprovalHandler,
  "ctx.on('approval/request', (req, next) => {\n"
  + "  workbenchPolicyStage('tui-approval-handler:before');\n"
  + "  return approvalStore.park(req).then(outcome => {\n"
  + "    workbenchPolicyStage('tui-approval-handler:resolved');\n"
  + "    return outcome;\n"
  + "  }).catch(() => {\n"
  + "    workbenchPolicyStage('tui-approval-handler:fallback');\n"
  + "    return next();\n"
  + "  });\n"
  + '});');
writeFileSync(tuiPluginPath, marker + tuiPlugin);
instrument(tuiRoot, 'dsh-adapter/approvals.js', [
  ['this.queue.push(pending);\n            this.startNext();', 'tui-approval-park'],
]);
console.log('Installed disposable profile has stage-only diagnostic instrumentation');
