import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { materializeTuiEntry, projectTuiResume } from '../src/launch-workbench.ts';

test('TUI resume projects the exact ID without changing approval configuration', () => {
  const environment = { DSH_TUI_RESUME_SESSION: 'old-session', DSH_HOME: '/fixture/home',
    DSH_PERMISSION_MODE: 'workspace-write', DSH_RUNTIME_KIT_AGENT_HOOK_CONFIG: '/fixture/policy' };
  const args = ['--profile', 'workbench', '--resume', 'exact-session'];
  const tui = projectTuiResume(args, environment);
  assert.deepEqual(tui.args, ['--profile', 'workbench']);
  assert.deepEqual(tui.environment, { ...environment, DSH_TUI_RESUME_SESSION: 'exact-session' });
  assert.equal(environment.DSH_TUI_RESUME_SESSION, 'old-session');
  assert.equal(projectTuiResume([], environment).environment.DSH_TUI_RESUME_SESSION, undefined,
    'A new TUI invocation must not inherit a previous resume selection');
  assert.deepEqual(projectTuiResume(['--profile','workbench','--resume=exact-session'], {}),
    { args: ['--profile','workbench'], environment: { DSH_TUI_RESUME_SESSION: 'exact-session' } });
  for (const invalid of [['--resume'], ['--resume='], ['--resume','--help'],
    ['--resume','one','--resume=two'],['--','--resume','literal'],['-c'],['--continue']]) assert.throws(() => projectTuiResume(invalid, {}),
      /WORKBENCH_RESUME_INVALID/);
});

test('installed launch replaces the process and preserves owner arguments and exit status', () => {
  if (process.platform !== 'linux') return;
  const root = mkdtempSync(join(tmpdir(), 'workbench-exec-'));
  try {
    const kit = join(root, 'kit'), runtime = join(root, 'runtime'), cli = join(root, 'cli.mjs');
    mkdirSync(join(kit, 'dist/bin'), { recursive:true }); mkdirSync(runtime);
    writeFileSync(cli, 'export {};\n');
    const receipt = join(root, 'receipt.json');
    const entryRoot = join(root, 'installed-entry');
    materializeTuiEntry(entryRoot, '0.1.0-rc.11');
    const entryReceipt=JSON.parse(readFileSync(join(entryRoot,'receipt.json'),'utf8'));
    const entry=join(entryRoot,entryReceipt.entry);
    writeFileSync(join(kit, 'dist/bin/dsh-runtime-kit-launch.js'),
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({pid:process.pid,args:process.argv.slice(2),home:process.env.DSH_HOME,resume:process.env.DSH_TUI_RESUME_SESSION}));process.exit(23);\n`);
    const result = spawnSync(process.execPath, [entry, kit, runtime, cli,
      '--', '--profile', 'workbench', '--resume', 'exact-session'],
      { cwd:root,encoding:'utf8', env:{...process.env,DSH_HOME:root} });
    assert.equal(result.status,23);
    const observed=JSON.parse(readFileSync(receipt,'utf8'));
    assert.equal(observed.pid,result.pid,'Launcher must replace itself rather than add a supervisor');
    assert.deepEqual(observed.args,['--runtime-root',runtime,'--',process.execPath,cli,
      '--profile','workbench']);
    assert.equal(observed.home,root);
    assert.equal(observed.resume,'exact-session');
    rmSync(receipt);
    for (const args of [['--resume'],['--resume','one','--resume=two'],['--','--resume','one'],['-c'],['--continue'],
      ['--profile','other'],['--profile','workbench','--profile','workbench']]) {
      const refused = spawnSync(process.execPath,[entry,kit,runtime,cli,'--',...args],
        {cwd:root,encoding:'utf8'});
      assert.equal(refused.status,64);
      assert.match(refused.stderr,/WORKBENCH_(RESUME|PROFILE)_INVALID/);
      assert.throws(()=>readFileSync(receipt),/ENOENT/,'Invalid launch must not execute the owner');
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
