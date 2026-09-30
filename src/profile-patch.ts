/**
 * The Workbench profile's own patch layer, applied after the DSH and dsh-TUI bundles.
 *
 * - Registers the Web plugin.
 * - Keeps approvals asking. The installed launch runs DSH as a full host agent, whose
 *   preset would otherwise reject every approval-gated action instead of asking.
 * - Keeps the official CLI's Claude Code hook bridge disabled unless the installed TUI
 *   launch runs as an agent-session managed pane and names its activity hooks.
 * - Offers the Codex subscription route and an owner-selected default model. Each stays
 *   off until the owner environment names its endpoint or route, so an unconfigured
 *   install composes the DeepSeek routes and the default model of the base bundle. The
 *   patch holds no endpoint and no credential value.
 * - Leaves the `llm-pi-ai` row to the base bundle: the Web Models page saves its
 *   providers there, and a patch row would replace that config.
 * - Restates the dsh-TUI row without its `effort`, so the TUI honors the user's stored
 *   `/effort` choice and otherwise the route's own default. A row-level effort outranks
 *   the stored choice and would reset it in every new session.
 * - Runs the TUI inline, not on the alternate screen, inside an agent-session managed
 *   pane. The host replays and scrolls such a pane itself. The installed launch sets
 *   `DSH_WORKBENCH_AGENT_SESSION_HOOKS` only for a complete managed pane.
 */
const codexModels = [
  ['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6-sol', 'GPT-6 Sol'],
  ['gpt-6-astra', 'GPT-6 Astra'], ['gpt-6-luna', 'GPT-6 Luna'],
] as const;

/** The base bundle's default, restated because a patch replaces a row's whole config. */
export const BASE_DEFAULT_MODEL = { provider: 'deepseek-official', model: 'deepseek-flash' } as const;

/** Fullscreen as in the bundle, except inside an agent-session managed pane. */
export const TUI_FULLSCREEN = "fullscreen: !!js '!process.env.DSH_WORKBENCH_AGENT_SESSION_HOOKS'";

/**
 * The dsh-TUI bundle's own `dsh-tui` row config, without `effort` and with the managed-pane
 * fullscreen rule. A patch replaces a row's whole config, so every other key is restated;
 * the combined-profile check compares these lines with the pinned bundle.
 */
export const TUI_ROW_CONFIG = [
  'provider: deepseek-official',
  TUI_FULLSCREEN,
  'terminalImages: true',
  'preset: !!js process.env.DSH_TUI_PRESET ?? undefined',
  'workspace: !!js process.env.DSH_TUI_WORKSPACE_TARGET ?? undefined',
  'sessionId: !!js process.env.DSH_TUI_RESUME_SESSION ?? undefined',
] as const;

export const WORKBENCH_PROFILE_PATCH = [
  '- insert:',
  '    - id: dsh-workbench-web',
  "      name: '@sympoies/dsh-workbench-web'",
  '    - id: hooks-claude-code',
  "      name: '@deepseek-ai/dsh-hooks-claude-code'",
  "      disabled: !!js '!process.env.DSH_WORKBENCH_AGENT_SESSION_HOOKS'",
  '      config:',
  "        configPath: !!js process.env.DSH_WORKBENCH_AGENT_SESSION_HOOKS ?? ''",
  '        defaultTimeoutMs: 10000',
  '    - id: llm-codex-subscription',
  "      name: '@sympoies/dsh-llm-codex-subscription'",
  "      disabled: !!js '!process.env.DSH_CODEX_SUBSCRIPTION_URL'",
  '      config:',
  "        baseURL: !!js process.env.DSH_CODEX_SUBSCRIPTION_URL || ''",
  '        apiKeyEnv: DSH_CODEX_SUBSCRIPTION_TOKEN',
  '        reasoning: high',
  '        models:',
  ...codexModels.flatMap(([id, name]) => [
    `          - id: ${id}`,
    `            name: ${name}`,
    '            contextWindow: 272000',
    '            maxTokens: 128000',
  ]),
  '- id: approval',
  '  config:',
  '    policy: ask',
  '- id: agent-default-model',
  '  config: !!js |-',
  '    (() => {',
  '      const provider = process.env.DSH_WORKBENCH_DEFAULT_PROVIDER;',
  '      const model = process.env.DSH_WORKBENCH_DEFAULT_MODEL;',
  `      return provider && model ? { provider, model } : { provider: '${BASE_DEFAULT_MODEL.provider}', model: '${BASE_DEFAULT_MODEL.model}' };`,
  '    })()',
  '- id: dsh-tui',
  '  config:',
  ...TUI_ROW_CONFIG.map(line => `    ${line}`),
  '',
].join('\n');
