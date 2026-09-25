import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readEvents } from './session-events.ts';

function compressed(text: string): Buffer {
  const result = spawnSync('zstd', ['-q', '-c'], { input: text, maxBuffer: 1_000_000 });
  assert.equal(result.status, 0);
  return result.stdout;
}

test('strict Session V4 read accepts complete JSON lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-events-'));
  try {
    const path = join(root, 'session.v4.jsonl.zstd');
    writeFileSync(path, compressed('{"type":"turn/end","data":{"reason":{"kind":"completed"}}}\n'));
    assert.equal(readEvents(path, { strict: true })[0]?.type, 'turn/end');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('strict Session V4 read rejects malformed JSON after valid events', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-events-'));
  try {
    const path = join(root, 'session.v4.jsonl.zstd');
    writeFileSync(path, compressed('{"type":"turn/end"}\n{"type":\n'));
    assert.throws(() => readEvents(path, { strict: true }), /invalid Session V4 JSON/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('strict Session V4 read rejects a truncated compressed frame after valid events', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-session-events-'));
  try {
    const path = join(root, 'session.v4.jsonl.zstd');
    const later = compressed('{"type":"assistant/message"}\n');
    writeFileSync(path, Buffer.concat([
      compressed('{"type":"turn/end"}\n'), later.subarray(0, later.length - 2),
    ]));
    assert.throws(() => readEvents(path, { strict: true }), /could not decompress Session V4/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
