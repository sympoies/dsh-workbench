import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

type Component = { source: { url: string; commit: string; tag?: string } };
type Contract = {
  components: {
    dsh: Component;
    runtimeKit: Component;
    tui: Component;
    codexSubscription: Component;
  };
};
const contract = JSON.parse(readFileSync(new URL('../compatibility/workbench.json', import.meta.url), 'utf8')) as Contract;
const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
const publication = readFileSync(new URL('../docs/publication.md', import.meta.url), 'utf8');

const components = [
  { key: 'dsh', heading: '## DeepSeek Harness', row: '| DeepSeek Harness |' },
  { key: 'tui', heading: '## dsh-TUI', row: '| dsh-TUI |' },
  { key: 'runtimeKit', heading: '## dsh-runtime-kit', row: '| dsh-runtime-kit |' },
  { key: 'codexSubscription', heading: '## Codex subscription provider', row: '| Codex subscription provider |' },
] as const;

function sectionAfter(markdown: string, heading: string): string {
  const start = markdown.indexOf(`${heading}\n`);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const end = markdown.indexOf('\n## ', start + heading.length);
  return markdown.slice(start, end === -1 ? undefined : end);
}

function assertPinnedSourcesMatchDocs(current: Contract, currentNotices: string, currentPublication: string): void {
  for (const component of components) {
    const source = current.components[component.key].source;
    const section = sectionAfter(currentNotices, component.heading);
    assert.ok(section.includes(`\`${source.commit}\``), `${component.key} notice has stale commit`);
    assert.ok(section.includes(`${source.url}/blob/${source.commit}/LICENSE`),
      `${component.key} notice links to a stale source license`);
    if (source.tag !== undefined) assert.ok(section.includes(`\`${source.tag}\``), `${component.key} notice has stale tag`);

    const rows = currentPublication.split('\n').filter(line => line.startsWith(component.row));
    assert.equal(rows.length, 1, `${component.key} must have one publication table row`);
    assert.ok(rows[0].includes(source.url), `${component.key} publication row has stale repository`);
    assert.ok(rows[0].includes(source.commit), `${component.key} publication row has stale commit`);
    assert.ok(rows[0].includes(`${source.url}/tree/${source.commit}`),
      `${component.key} publication row links to a stale source revision`);
    assert.ok(rows[0].includes(`${source.url}/blob/${source.commit}/LICENSE`),
      `${component.key} publication row links to a stale license`);
    if (source.tag !== undefined) assert.ok(rows[0].includes(source.tag), `${component.key} publication row has stale tag`);
  }
}

test('third-party notices and publication table track each exact contract source', () => {
  assertPinnedSourcesMatchDocs(contract, notices, publication);

  for (const holder of [
    'Copyright (c) 2026 DeepSeek',
    'Copyright (c) 2026, chimney (ccch1mneyyy)',
    'Copyright (c) 2026 Sympoies contributors',
  ]) {
    assert.ok(notices.includes(holder), `missing upstream notice ${holder}`);
  }

  assert.equal((notices.match(/MIT License/g) ?? []).length, 4);
});

test('rejects a new contract pin appended outside a stale component section', () => {
  const changed = structuredClone(contract);
  changed.components.dsh.source.commit = 'a'.repeat(40);
  const noticesWithUnrelatedAppend = `${notices}\nThe updated revision is ${changed.components.dsh.source.commit}.\n`;
  assert.ok(noticesWithUnrelatedAppend.includes(changed.components.dsh.source.commit));
  assert.throws(() => assertPinnedSourcesMatchDocs(changed, noticesWithUnrelatedAppend, publication),
    /dsh notice has stale commit/);
});

test('rejects a stale publication row when a component pin changes', () => {
  const changed = structuredClone(contract);
  changed.components.runtimeKit.source.commit = 'b'.repeat(40);
  const noticesUpdated = notices.split(contract.components.runtimeKit.source.commit)
    .join(changed.components.runtimeKit.source.commit);
  assert.throws(() => assertPinnedSourcesMatchDocs(changed, noticesUpdated, publication),
    /runtimeKit publication row has stale commit/);
});
