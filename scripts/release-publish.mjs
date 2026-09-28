import { publishLinuxRelease } from '../src/linux-release-publisher.ts';

await publishLinuxRelease(process.argv.slice(2));
