import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

/** Point a disposable installed-profile fixture at its current local mock. */
export function configureOwnerBackend(ownerFile: string | undefined,
  baseURL: string, apiKey: string): void {
  if (!ownerFile) return;
  const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as {
    schemaVersion?: string;
    environment?: Record<string, string>;
    secretFiles?: Record<string, string>;
  };
  assert.equal(owner.schemaVersion, 'dsh-workbench.owner-environment.v1');
  const keyFile = owner.secretFiles?.DEEPSEEK_API_KEY;
  assert.ok(keyFile, 'Installed owner fixture requires a private key file reference');
  writeFileSync(keyFile, `${apiKey}\n`, { mode: 0o600 });
  owner.environment = { ...owner.environment, DEEPSEEK_BASE_URL: `${baseURL}/v1` };
  writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}
