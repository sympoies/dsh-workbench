#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { stageCombinedProfileFromPinnedKit } from '../src/combined-profile.ts';

const [kitRepo, receiptFile, tuiArchive, dshHome] = process.argv.slice(2);
if (!kitRepo || !receiptFile || !tuiArchive || !dshHome || !isAbsolute(dshHome) || process.argv.length !== 6) {
  process.stderr.write('Usage: node scripts/combined-profile.mjs <kit-git-repo> <runtime-kit-peer-receipt.json> <tui-archive.tgz> <absolute-dsh-home>\n');
  process.exit(64);
}

try {
  const receipt = JSON.parse(readFileSync(resolve(receiptFile), 'utf8'));
  stageCombinedProfileFromPinnedKit({ dshHome, receipt,
    tuiArchive: resolve(tuiArchive), kitRepo: resolve(kitRepo) });
  process.stdout.write('Combined candidate profile staged; run strict pnpm install, then runtime-kit setup and doctor.\n');
} catch (error) {
  process.stderr.write(`Combined profile staging failed: ${error instanceof Error ? error.message : 'invalid input'}\n`);
  process.exit(1);
}
