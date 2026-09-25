import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { workbenchIdentity as publishedIdentity } from '../lib/index.js';
import { workbenchIdentity } from '../src/identity.ts';

type ClientPlugin = { inject: string[]; apply: (ctx: ClientContext) => void };
type Registration = { id: string; factory: (require: NodeJS.Require) => ClientPlugin };

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
let registration: Registration | undefined;
let writeText: (value: string) => Promise<void> = async () => {};
runInNewContext(source, {
  window: { __ModuleLoader__: { load(value: Registration) { registration = value; } } },
  navigator: { clipboard: { writeText(value: string) { return writeText(value); } } },
});
assert.equal(registration?.id, '@sympoies/dsh-workbench-web');
assert.doesNotMatch(source, /^(?:import|export)\s/m);
const plugin = registration!.factory(createRequire(import.meta.url));

let component: ComponentType<{ sessionId: string }>;
test('built Client module registers an additive DSH header action', () => {
  let injectedSeat: string | undefined;
  let options: { name: string; id: string } | undefined;
  const ctx = {
    slots: {
      inject(name: string, install: () => void) {
        injectedSeat = name;
        install();
      },
      register(value: { name: string; id: string }, action: ComponentType<{ sessionId: string }>) {
        options = value;
        component = action;
        return () => {};
      },
    },
  } as unknown as ClientContext;
  plugin.apply(ctx);
  assert.deepEqual(Array.from(plugin.inject), ['slots']);
  assert.equal(injectedSeat, 'conversation.session.header.utilities');
  assert.equal(options?.name, injectedSeat);
  assert.equal(options?.id, 'dsh-workbench-handoff');
  const html = renderToStaticMarkup(createElement(component, { sessionId: 'session-one' }));
  assert.match(html, /Copy Session ID/);
  assert.doesNotMatch(html, /session-one/);
  assert.ok(html.includes(workbenchIdentity.contractDigest));
  assert.ok(html.includes(workbenchIdentity.release.version));
  assert.ok(html.includes(`(${workbenchIdentity.status})`));
  assert.ok(html.includes(`DSH ${workbenchIdentity.components.dsh.package.version}`));
  assert.ok(html.includes(workbenchIdentity.components.runtimeKit.source.commit));
  assert.ok(html.includes(`TUI ${workbenchIdentity.components.tui.package.version}`));
  assert.deepEqual(publishedIdentity, workbenchIdentity);
});

test('handoff copies the exact Session ID and reports success', async () => {
  const copied: string[] = [];
  writeText = async value => { copied.push(value); };
  try {
    const renderer = TestRenderer.create(createElement(component, { sessionId: 'session-one' }));
    await act(async () => { renderer.root.findByType('button').props.onClick(); });
    assert.deepEqual(copied, ['session-one']);
    assert.match(JSON.stringify(renderer.toJSON()), /Stop Web Host before resuming in TUI/);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /session-one/);
    renderer.unmount();
  } finally {
    writeText = async () => {};
  }
});

test('handoff reports clipboard denial without exposing the Session ID', async () => {
  writeText = async () => { throw new Error('denied'); };
  try {
    const renderer = TestRenderer.create(createElement(component, { sessionId: 'session-two' }));
    await act(async () => { renderer.root.findByType('button').props.onClick(); });
    assert.match(JSON.stringify(renderer.toJSON()), /Could not copy the Session ID/);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /session-two/);
    renderer.unmount();
  } finally {
    writeText = async () => {};
  }
});
