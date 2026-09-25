# Native Web extension candidate

The Web package at `web/` targets the exact DSH source and package version in
[the Workbench contract](../compatibility/workbench.json). It is an out-of-tree
client plugin. The server entry is intentionally empty; DSH owns the Host,
session writer, transport, conversation, tools, approvals, terminal, settings,
and plugins.

DSH 0.1.7-rc.1 provides explicit
[`ISessions.retain`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/api/session-controller/src/client/contract/sessions.ts)
references and a
[`SessionProvider` target](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/client/ui-sidebar-right/src/client/shell/RightbarRoot.tsx).
The prior addressed-session source patch is therefore excluded from this
candidate. An eventual multi-pane contribution must use these public owners
and prove lifecycle behavior in a real browser before acceptance.

The first additive action uses the official
[`conversation.session.header.utilities` slot](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/client/ui-conversation/src/client/contract/slots.ts)
to copy a session ID for TUI handoff. It reminds the user to stop the Web Host
before TUI resume. It never releases a writer, modifies session data, or
replaces the native conversation.

The Web package version, pnpm DSH catalog, and generated Client identity are
checked against the sole Workbench contract by
`node scripts/web-metadata.mjs check`. The identity reports the Workbench
version, contract status and digest, and all three pinned component identities
through the Web handoff action and the package's server export. The package
build rejects stale generated identity before bundling. After a deliberate
contract revision, run `node scripts/web-metadata.mjs write` and regenerate
the frozen lockfile. The package remains private until release packaging and
artifact review are established.

No predecessor source file or history was copied. This candidate has strict
dependency installation, a TypeScript build that emits the DSH Client module
loader format, and artifact-level registration and clipboard interaction tests.
The packaged plugin loaded without page errors in a disposable native Web
profile on the pinned DSH runtime. The [browser acceptance script](../tests/web-browser-acceptance.ts)
uses a local mock LLM to create four distinct sessions, checks their separate
histories and copied IDs, exercises a pending turn, a tool approval and
rejection, and a provider error. It restarts the Web Host and reopens all
four, including the settled tool results and failed turn. It also verifies a
TUI-created session's manual title and history in Web, writer contention while
Web owns a session, and exact-ID TUI continuation after Web stops. It
requires explicit paths to the pinned DSH executable and a Chromium executable;
see [development instructions](../DEVELOPMENT.md). Image composition, installed
graph mismatch rejection, and cross-platform evidence remain acceptance work under
[#5](https://github.com/sympoies/dsh-workbench/issues/5); cross-interface
handoff remains under [#7](https://github.com/sympoies/dsh-workbench/issues/7).
