import { spawnSync } from 'node:child_process';

export type SessionEvent = { type: string; data?: Record<string, unknown> };

export function readEvents(path: string, options: { strict?: boolean } = {}): SessionEvent[] {
  const result = spawnSync('zstdcat', [path], { encoding: 'utf8', timeout: 5_000, maxBuffer: 32_000_000 });
  if (options.strict && (result.error || result.status !== 0)) {
    throw new Error('Could not decompress Session V4 archive');
  }
  const lines = result.stdout?.split('\n').filter(Boolean) ?? [];
  return lines.flatMap((line, index) => {
    try { return [JSON.parse(line) as SessionEvent]; }
    catch {
      if (options.strict) throw new Error(`Invalid Session V4 JSON at line ${index + 1}`);
      return [];
    }
  });
}
