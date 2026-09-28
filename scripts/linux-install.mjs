import { applyLinuxInstall, planLinuxInstall } from '../src/linux-installer.ts';
import { readOwnerFile } from '../src/linux-owner-input.ts';

const [command, inputPath, expectedPlanDigest] = process.argv.slice(2);
if (!['plan', 'apply'].includes(command) || !inputPath
  || (command === 'apply' && !expectedPlanDigest)
  || (command === 'plan' && expectedPlanDigest)) {
  throw new Error('usage: node scripts/linux-install.mjs plan|apply ABSOLUTE_PRIVATE_INPUT_JSON [EXPECTED_PLAN_DIGEST]');
}
const input = JSON.parse(readOwnerFile(inputPath, 'Linux install input', true).toString('utf8'));
const result = command === 'plan'
  ? planLinuxInstall(input)
  : applyLinuxInstall(input, expectedPlanDigest);
process.stdout.write(`${JSON.stringify(result)}\n`);
