import assert from 'node:assert/strict';
import test from 'node:test';
import { TUI_ROW_CONFIG, WORKBENCH_PROFILE_PATCH } from '../src/profile-patch.ts';

/** Evaluate one `!!js` scalar of the patch the way DSH does, with a chosen environment. */
function evaluate(expression: string, environment: Record<string, string>): unknown {
  return new Function('process', `return (${expression});`)({ env: environment });
}

/** The `!!js` expression of `key` inside the row that starts with `- id: <row>`. */
function expressionOf(row: string, key: string): string {
  const lines = WORKBENCH_PROFILE_PATCH.split('\n');
  const start = lines.findIndex(line => line.trimStart() === `- id: ${row}`);
  assert.notEqual(start, -1, `patch row is missing: ${row}`);
  const rowIndent = lines[start].indexOf('-');
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    const indent = line.length - line.trimStart().length;
    if (line.trim() && indent <= rowIndent) break;
    const found = new RegExp(`^\\s*${key}: !!js (.*)$`).exec(line);
    if (!found) continue;
    if (found[1] !== '|-') {
      const quoted = /^'(.*)'$/.exec(found[1]);
      return quoted ? quoted[1].replaceAll("''", "'") : found[1];
    }
    const block: string[] = [];
    for (let next = index + 1; next < lines.length; next++) {
      const blockIndent = lines[next].length - lines[next].trimStart().length;
      if (lines[next].trim() && blockIndent <= indent) break;
      block.push(lines[next]);
    }
    return block.join('\n');
  }
  assert.fail(`patch row ${row} has no !!js ${key}`);
}

const codexModels = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna'];
const configured = {
  DSH_CODEX_SUBSCRIPTION_URL: 'https://subscription.example.invalid/v1',
  DSH_CODEX_PROXY_URL: 'https://proxy.example.invalid/v1',
  DSH_WORKBENCH_DEFAULT_PROVIDER: 'codex-subscription',
  DSH_WORKBENCH_DEFAULT_MODEL: 'gpt-6.1-sol',
};

test('profile keeps the Web plugin and asking approvals', () => {
  assert.ok(WORKBENCH_PROFILE_PATCH.startsWith(
    "- insert:\n    - id: dsh-workbench-web\n      name: '@sympoies/dsh-workbench-web'\n"));
  assert.ok(WORKBENCH_PROFILE_PATCH.includes('\n- id: approval\n  config:\n    policy: ask\n'));
  assert.ok(WORKBENCH_PROFILE_PATCH.endsWith('\n'));
});

test('an unconfigured owner composes the DeepSeek-only routes and default of the base bundle', () => {
  assert.equal(evaluate(expressionOf('llm-codex-subscription', 'disabled'), {}), true);
  assert.deepEqual(evaluate(expressionOf('llm-pi-ai', 'config'), {}), {});
  assert.deepEqual(evaluate(expressionOf('agent-default-model', 'config'), {}),
    { provider: 'deepseek-official', model: 'deepseek-flash' });
  // An empty value is not a configuration.
  const empty = Object.fromEntries(Object.keys(configured).map(name => [name, '']));
  assert.equal(evaluate(expressionOf('llm-codex-subscription', 'disabled'), empty), true);
  assert.deepEqual(evaluate(expressionOf('llm-pi-ai', 'config'), empty), {});
  assert.deepEqual(evaluate(expressionOf('agent-default-model', 'config'), empty),
    { provider: 'deepseek-official', model: 'deepseek-flash' });
});

test('owner settings enable each Codex route and the default model independently', () => {
  assert.equal(evaluate(expressionOf('llm-codex-subscription', 'disabled'), configured), false);
  assert.equal(evaluate(expressionOf('llm-codex-subscription', 'baseURL'), configured),
    configured.DSH_CODEX_SUBSCRIPTION_URL);
  assert.ok(WORKBENCH_PROFILE_PATCH.includes(
    "      name: '@sympoies/dsh-llm-codex-subscription'\n"));
  assert.ok(WORKBENCH_PROFILE_PATCH.includes('        apiKeyEnv: DSH_CODEX_SUBSCRIPTION_TOKEN\n'));
  for (const id of codexModels) {
    assert.ok(WORKBENCH_PROFILE_PATCH.includes(`          - id: ${id}\n`), `subscription catalog lacks ${id}`);
  }
  const proxy = evaluate(expressionOf('llm-pi-ai', 'config'), configured) as {
    providers: Record<string, { apiKeyEnv: string; api: string; baseURL: string; models: Array<{ id: string }> }>;
  };
  assert.deepEqual(Object.keys(proxy.providers), ['codex-proxy']);
  assert.equal(proxy.providers['codex-proxy'].baseURL, configured.DSH_CODEX_PROXY_URL);
  assert.equal(proxy.providers['codex-proxy'].apiKeyEnv, 'DSH_CODEX_PROXY_TOKEN');
  assert.equal(proxy.providers['codex-proxy'].api, 'openai-responses');
  assert.deepEqual(proxy.providers['codex-proxy'].models.map(model => model.id), codexModels);
  assert.deepEqual(evaluate(expressionOf('agent-default-model', 'config'), configured),
    { provider: 'codex-subscription', model: 'gpt-6.1-sol' });
  // One route alone does not switch on the other.
  const subscriptionOnly = { DSH_CODEX_SUBSCRIPTION_URL: configured.DSH_CODEX_SUBSCRIPTION_URL };
  assert.deepEqual(evaluate(expressionOf('llm-pi-ai', 'config'), subscriptionOnly), {});
  assert.equal(evaluate(expressionOf('llm-codex-subscription', 'disabled'),
    { DSH_CODEX_PROXY_URL: configured.DSH_CODEX_PROXY_URL }), true);
});

test('a half-named default model never mixes with the base default', () => {
  const partials: Array<Record<string, string>> = [{ DSH_WORKBENCH_DEFAULT_PROVIDER: 'codex-subscription' },
    { DSH_WORKBENCH_DEFAULT_MODEL: 'gpt-6.1-sol' }];
  for (const partial of partials) {
    assert.deepEqual(evaluate(expressionOf('agent-default-model', 'config'), partial),
      { provider: 'deepseek-official', model: 'deepseek-flash' });
  }
});

test('the dsh-TUI row is restated without a reasoning effort', () => {
  const lines = WORKBENCH_PROFILE_PATCH.split('\n');
  const start = lines.indexOf('- id: dsh-tui');
  assert.notEqual(start, -1);
  const row = lines.slice(start + 1).filter(line => line.trim());
  // A row-level effort would outrank the user's stored /effort choice in every new session.
  assert.deepEqual(row, ['  config:', ...TUI_ROW_CONFIG.map(line => `    ${line}`)]);
  assert.ok(!TUI_ROW_CONFIG.some(line => line.startsWith('effort')));
  assert.deepEqual(TUI_ROW_CONFIG.map(line => line.split(':')[0]),
    ['provider', 'fullscreen', 'terminalImages', 'preset', 'workspace', 'sessionId']);
});

test('the TUI runs inline only inside an agent-session managed pane', () => {
  const fullscreen = expressionOf('dsh-tui', 'fullscreen');
  assert.equal(evaluate(fullscreen, {}), true);
  assert.equal(evaluate(fullscreen, { DSH_WORKBENCH_AGENT_SESSION_HOOKS: '' }), true);
  assert.equal(evaluate(fullscreen, { DSH_WORKBENCH_AGENT_SESSION_HOOKS: '/private/agent-session-hooks.json' }), false);
  // The Codex settings do not change the screen mode.
  assert.equal(evaluate(fullscreen, configured), true);
});

test('the patch carries no host endpoint or credential value', () => {
  assert.doesNotMatch(WORKBENCH_PROFILE_PATCH, /https?:\/\/|127\.0\.0\.1|localhost/);
  for (const line of WORKBENCH_PROFILE_PATCH.split('\n').filter(value => /TOKEN/.test(value))) {
    assert.match(line, /apiKeyEnv: '?DSH_CODEX_(SUBSCRIPTION|PROXY)_TOKEN'?,?$/);
  }
});
