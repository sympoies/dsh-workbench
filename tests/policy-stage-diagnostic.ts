import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { installedDependencyRoot } from './installed-package-root.ts';

const profile = process.argv[2];
const dshSource = process.argv[3];
assert.ok(profile && isAbsolute(profile), 'A disposable absolute profile path is required');
assert.ok(dshSource && isAbsolute(dshSource), 'The exact DSH source installation path is required');
const packageRoot = realpathSync(join(profile, 'node_modules', '@sympoies', 'dsh-runtime-kit'));
const tuiRoot = realpathSync(join(profile, 'node_modules',
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
  ['if (targets.length === 0) {', 'lease-empty-targets', 'before'],
  ['const authorization = this.#authorizations.get(exec);', 'lease-guard'],
  ['await owner.draining;', 'lease-owner-drain'],
  ['const anchor = owner.anchor ?? this.#startAnchor(owner);', 'lease-anchor-start'],
  ['await anchor.catch(() => { });', 'lease-anchor-wait'],
  ['const existing = owner.bindings.get(key);', 'lease-existing'],
  ['const inflight = owner.acquisitions.get(key);', 'lease-inflight'],
  ['return await acquisition;', 'lease-acquisition', 'before'],
  ['const granted = await this.#begin(binding, target, slot.session.header.cwd, identity, admissionSignal.signal);',
    'lease-begin'],
]);
instrument(packageRoot, 'dist/src/finish-line/index.js', [
  ['const registration = editRegistrations.get(exec);', 'finish-execute-entry'],
  ['const prepared = pending.prepared;', 'finish-validation-ready'],
  ['let operationId = pending.operationId;', 'finish-validation-probe'],
  ['if (!await ensureRunnerCapability(ledger, prepared.identity, exec.signal, operation.command)) {',
    'finish-capability', 'before'],
  ['const probe = await client.run({', 'finish-run-probe', 'before'],
  ['const runtime = await prepareValidationRuntime(exec, {', 'finish-runtime', 'before'],
]);
instrument(packageRoot, 'dist/src/finish-line/nils-client.js', [
  ['executionLease = authenticatedExecution.acquire(operation.controller.signal);', 'nils-acquire'],
  ['const argv = await resolveSubprocessArgv(ctx, agentHook.argv([\'finish-line\', action, \'--format\', \'json\']), executionSignal);',
    'nils-argv'],
  ['const handle = operation.handle;', 'nils-spawn-after', 'before'],
  ['const first = await Promise.race([', 'nils-wait', 'before'],
]);
const nilsClientPath = join(packageRoot, 'dist/src/finish-line/nils-client.js');
let nilsClient = readFileSync(nilsClientPath, 'utf8');
const spawnCall = nilsClient.match(/operation\.handle = executionLease\.spawn\(\{[\s\S]*?\n\s{16}\}\);/gu) ?? [];
assert.equal(spawnCall.length, 1, 'finish-line operation spawn must occur exactly once');
const instrumentedNilsClient = nilsClient.replace(spawnCall[0], `try {
  const cwdKind = typeof request.cwd !== 'string' ? 'missing'
    : request.cwd.startsWith('/') ? 'absolute' : 'other';
  const argvKind = Array.isArray(argv) && typeof argv[0] === 'string' && argv[0].length > 0
    ? 'valid' : 'invalid';
  const cancelCause = ['caller', 'timeout', 'disposed', 'degraded'].includes(operation.cause)
    ? operation.cause : 'none';
  const signalReason = executionSignal.reason;
  const reasonName = signalReason instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(signalReason.name)
    ? signalReason.name : 'none';
  const rawReasonCode = signalReason !== null && typeof signalReason === 'object'
    && 'code' in signalReason ? signalReason.code : undefined;
  const reasonCode = typeof rawReasonCode === 'string' && /^[A-Z0-9_-]{1,64}$/u.test(rawReasonCode)
    ? rawReasonCode : 'none';
  workbenchPolicyStage('nils-spawn-spec:' + action + ':' + cwdKind + ':' + argvKind
    + ':' + (executionSignal.aborted ? 'aborted' : 'live')
    + ':' + (operation.controller.signal.aborted ? 'parent-aborted' : 'parent-live')
    + ':' + cancelCause + ':' + reasonName + ':' + reasonCode);
${spawnCall[0]}
  workbenchPolicyStage('nils-spawn-created:' + action);
} catch (error) {
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(error.name)
    ? error.name : 'Unknown';
  const rawCode = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const errorCode = typeof rawCode === 'string' && /^[A-Z0-9_-]{1,40}$/u.test(rawCode)
    ? rawCode : 'none';
  const message = error instanceof Error ? error.message : '';
  const errorCategory = /^aborted before spawn:/u.test(message) ? 'pre-aborted'
    : /^invalid argv:/u.test(message) ? 'invalid-argv'
      : /^subprocess graceMs/u.test(message) ? 'invalid-grace'
        : /subprocess descriptor execution parent is not trusted/u.test(message) ? 'descriptor-parent'
          : /subprocess executable descriptor changed while reading/u.test(message) ? 'descriptor-read'
            : /cwd|working directory|directory/u.test(message) ? 'working-directory'
              : /environment|stdio|stdin|stdout|stderr/u.test(message) ? 'environment-or-stdio'
                : /descriptor|executable|subprocess|spawn/u.test(message) ? 'subprocess' : 'other';
  workbenchPolicyStage('nils-spawn-threw:' + action + ':' + errorName + ':' + errorCode
    + ':' + errorCategory);
  throw error;
}`);
assert.equal(instrumentedNilsClient.split('function workbenchPolicyStage(stage)').length, 2,
  'finish-line diagnostics must retain exactly one stage writer');
writeFileSync(nilsClientPath, instrumentedNilsClient);
const tuiPluginPath = join(tuiRoot, 'dsh-adapter/plugin.js');
let tuiPlugin = readFileSync(tuiPluginPath, 'utf8');
const tuiApprovalStoreCreation = 'const approvalStore = new ApprovalStore(adapterRuntimeFor(ctx));';
assert.equal(tuiPlugin.split(tuiApprovalStoreCreation).length, 2,
  'TUI approval store initialization must occur exactly once');
tuiPlugin = tuiPlugin.replace(tuiApprovalStoreCreation,
  "workbenchPolicyStage('tui-adapter-loaded');\n" + tuiApprovalStoreCreation);
const tuiApprovalAvailabilityGuard = "if (ctx.get('approval') !== undefined) {";
assert.equal(tuiPlugin.split(tuiApprovalAvailabilityGuard).length, 2,
  'TUI approval availability guard must occur exactly once');
tuiPlugin = tuiPlugin.replace(tuiApprovalAvailabilityGuard,
  "workbenchPolicyStage('tui-approval-available:' + (ctx.get('approval') !== undefined));\n"
  + tuiApprovalAvailabilityGuard);
const tuiApprovalHandler = "ctx.on('approval/request', (req, next) => approvalStore.park(req).catch(() => next()), { global: true, prepend: true });";
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
  + '}, { global: true, prepend: true });\n'
  + "workbenchPolicyStage('tui-approval-handler:registered:' + ctx.events._hooks['approval/request'].map(hook => hook.global ? 'global' : 'scoped').join(','));");
writeFileSync(tuiPluginPath, marker + tuiPlugin);
instrument(tuiRoot, 'dsh-adapter/approvals.js', [
  ['this.queue.push(pending);\n            this.startNext();', 'tui-approval-park'],
]);
// DSH resolves in-box bundles from its installation, which is this exact
// source checkout in the acceptance harness. The CLI declares dsh-base as a
// workspace dependency, but dsh-base owns the approval/Cordis importer graph.
const dshBaseRoot = join(dshSource, 'packages/bundle/base');
assert.equal(JSON.parse(readFileSync(join(dshBaseRoot, 'package.json'), 'utf8')).name,
  '@deepseek-ai/dsh-base', 'The exact DSH source must contain its in-box base bundle');
const approvalRoot = installedDependencyRoot(dshBaseRoot, '@deepseek-ai/dsh-user-approval');
instrument(approvalRoot, 'lib/index.js', [
  ['const answer = Promise.resolve().then(() => this.ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable"))).then((outcome) => OUTCOMES.includes(outcome) ? outcome : "unavailable", () => "unavailable");',
    'approval-service-waterfall'],
]);
const cordisRoot = installedDependencyRoot(dshBaseRoot, '@deepseek-ai/cordis');
const cordisEventsPath = join(cordisRoot, 'lib/index.js');
let cordisEvents = readFileSync(cordisEventsPath, 'utf8');
const cordisDispatch = 'if (!name.startsWith("internal/")) this.emit("internal/dispatch", type, name, args, thisArg);';
assert.equal(cordisEvents.split(cordisDispatch).length, 2,
  'Cordis dispatch instrumentation target must occur exactly once');
cordisEvents = cordisEvents.replace(cordisDispatch,
  'if (name === "approval/request") workbenchPolicyStage("cordis-approval-dispatch");\n' + cordisDispatch);
const cordisFilter = 'return (this._hooks[name] || []).filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx)).map((hook) => hook.callback.bind(thisArg));';
assert.equal(cordisEvents.split(cordisFilter).length, 2,
  'Cordis listener filter instrumentation target must occur exactly once');
cordisEvents = cordisEvents.replace(cordisFilter,
  'const selected = (this._hooks[name] || []).filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx));\n'
  + 'if (name === "approval/request") workbenchPolicyStage("cordis-approval-listeners:" + selected.map(hook => (hook.global ? "global" : "scoped") + ":" + String(hook.ctx.fiber.name ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48)).join(","));\n'
  + 'return selected.map((hook) => (...callbackArgs) => {\n'
  + '  if (name === "approval/request") workbenchPolicyStage("cordis-approval-callback:" + String(hook.ctx.fiber.name ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48));\n'
  + '  return hook.callback.apply(thisArg, callbackArgs);\n'
  + '});');
writeFileSync(cordisEventsPath, marker + cordisEvents);
console.log('Installed disposable profile has stage-only diagnostic instrumentation');
