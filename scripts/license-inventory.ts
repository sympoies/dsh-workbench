#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import {
  LicenseReportError,
  normalizePnpmLicenseReport,
  type LicenseReportErrorCode,
} from '../src/license-inventory.ts';

const diagnostics: Record<LicenseReportErrorCode, string> = {
  'invalid-report': 'invalid license report',
  'invalid-license-group': 'invalid license group',
  'invalid-package-group': 'invalid package group',
  'invalid-package-entry': 'invalid package entry',
  'invalid-package-name': 'invalid package name',
  'invalid-license-metadata': 'invalid license metadata',
  'inconsistent-license-metadata': 'inconsistent license metadata',
  'missing-package-versions': 'missing package versions',
  'invalid-package-version': 'invalid package version',
  'conflicting-package-license': 'conflicting package licenses',
  'empty-production-inventory': 'empty production inventory',
};

async function main(): Promise<void> {
  const [inputPath] = process.argv.slice(2);
  if (!inputPath || process.argv.length !== 3) {
    process.stderr.write('Usage: node scripts/license-inventory.ts PNPM_LICENSES_JSON\n');
    process.exitCode = 2;
    return;
  }

  let contents: string;
  try {
    contents = await readFile(inputPath, 'utf8');
  } catch {
    process.stderr.write('license-inventory: could not read the dependency license report\n');
    process.exitCode = 1;
    return;
  }

  let input: unknown;
  try {
    input = JSON.parse(contents) as unknown;
  } catch {
    process.stderr.write('license-inventory: malformed JSON report\n');
    process.exitCode = 1;
    return;
  }

  try {
    const inventory = normalizePnpmLicenseReport(input);
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  } catch (error) {
    const diagnostic = error instanceof LicenseReportError
      ? diagnostics[error.code]
      : 'could not validate the dependency license report';
    process.stderr.write(`license-inventory: ${diagnostic}\n`);
    process.exitCode = 1;
  }
}

await main();
