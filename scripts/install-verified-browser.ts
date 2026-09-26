import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, mkdirSync, readFileSync, accessSync, appendFileSync, constants } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';

type BrowserContract = {
  schemaVersion: string;
  playwrightCoreVersion: string;
  chromium: { revision: string; version: string };
  platforms: Record<string, { url: string; sha256: string; executable: string }>;
};

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4_096 });
  assert.equal(result.error, undefined, `${command} could not start`);
  assert.equal(result.status, 0, `${command} failed with exit ${result.status}`);
}

const outIndex = process.argv.indexOf('--out');
const out = process.argv[outIndex + 1];
assert.ok(outIndex >= 0 && out && outIndex + 2 === process.argv.length,
  'Usage: node scripts/install-verified-browser.ts --out <absolute directory>');
assert.equal(resolve(out), out, 'Browser output must be absolute');
const environmentFile = process.env.GITHUB_ENV;
assert.ok(environmentFile, 'GITHUB_ENV must identify the CI environment file');

const contract = JSON.parse(readFileSync(new URL('../compatibility/browser-ci.json', import.meta.url), 'utf8')) as BrowserContract;
assert.equal(contract.schemaVersion, 'dsh-workbench.browser-ci.v1');
const platform = `${process.platform}-${process.arch}`;
const artifact = contract.platforms[platform];
assert.ok(artifact, `No verified browser archive for ${platform}`);
assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
assert.match(artifact.url, /^https:\/\/cdn\.playwright\.dev\/builds\/cft\/[A-Za-z0-9./-]+\.zip$/);
assert.equal(artifact.url.includes(`/${contract.chromium.version}/`), true);
assert.ok(artifact.executable && !artifact.executable.startsWith('/')
  && !artifact.executable.split('/').includes('..'), 'Browser executable path is invalid');

const require = createRequire(import.meta.url);
const packagePath = require.resolve('playwright-core/package.json');
const playwright = JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string };
const browsers = JSON.parse(readFileSync(join(dirname(packagePath), 'browsers.json'), 'utf8')) as {
  browsers: { name: string; revision: string; browserVersion: string }[];
};
const chromium = browsers.browsers.find(browser => browser.name === 'chromium');
assert.equal(playwright.version, contract.playwrightCoreVersion);
assert.equal(chromium?.revision, contract.chromium.revision);
assert.equal(chromium?.browserVersion, contract.chromium.version);

mkdirSync(out, { recursive: true });
const directory = mkdtempSync(join(out, 'verified-chromium-'));
const archive = join(directory, 'chromium.zip');
run('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https',
  '--proto-redir', '=https',
  '--tlsv1.2', '--output', archive, artifact.url]);
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
assert.equal(hash.digest('hex'), artifact.sha256, 'Chromium archive SHA-256 mismatch');
const extracted = join(directory, 'browser');
run('unzip', ['-q', archive, '-d', extracted]);
const executable = resolve(extracted, artifact.executable);
assert.ok(executable.startsWith(`${extracted}${sep}`), 'Browser executable escaped the verified archive root');
accessSync(executable, constants.X_OK);
appendFileSync(environmentFile, `WORKBENCH_BROWSER_BIN=${executable}\n`);
console.log(JSON.stringify({ result: 'pass', platform, revision: chromium.revision,
  archiveSha256: artifact.sha256 }));
