#!/usr/bin/env node
import { launchWorkbenchTui } from '../src/launch-workbench.ts';

try {
  launchWorkbenchTui(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'WORKBENCH_LAUNCH_FAILED'}\n`);
  process.exitCode = 64;
}
