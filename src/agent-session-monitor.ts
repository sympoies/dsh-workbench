import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** One Session V4 event as DSH records it. */
export type SessionEvent = { type: string; seq?: number; time?: number; cwd?: string; data?: Record<string, any> };

export type OpenApproval = { id: string; tool: string; reason: string; arguments: string };

/** What an external supervisor needs to decide its next action. */
export type SessionSummary = {
  session: string;
  cwd: string | null;
  state: 'running' | 'approval-pending' | 'idle';
  turns: { started: number; ended: number; lastEnd: string | null };
  steps: number;
  toolCalls: number;
  toolErrors: number;
  tools: Record<string, number>;
  approvals: { asked: number; decided: number; outcomes: string[] };
  openApprovals: OpenApproval[];
  lastEvent: string | null;
  lastEventTime: number | null;
};

const ARGUMENT_LIMIT = 4000;

/** Reduce an ordered event list to the supervisor view; never includes message text. */
export function summarizeSession(session: string, events: SessionEvent[]): SessionSummary {
  const count = (type: string) => events.filter(event => event.type === type).length;
  const calls = new Map<string, Record<string, any>>();
  for (const event of events) {
    if (event.type === 'tool/call' && event.data?.callId) calls.set(event.data.callId, event.data);
  }
  const decided = events.filter(event => event.type === 'approval/decided');
  const decidedIds = new Set(decided.map(event => event.data?.id));
  const openApprovals = events
    .filter(event => event.type === 'approval/asked' && !decidedIds.has(event.data?.id))
    .map(event => ({
      id: String(event.data?.id),
      tool: String(event.data?.toolName ?? ''),
      reason: String(event.data?.reason ?? ''),
      arguments: String(calls.get(event.data?.callId)?.arguments ?? '').slice(0, ARGUMENT_LIMIT),
    }));
  const tools: Record<string, number> = {};
  for (const call of calls.values()) tools[call.name] = (tools[call.name] ?? 0) + 1;
  const turnEnds = events.filter(event => event.type === 'turn/end');
  const started = count('turn/start');
  const last = events.at(-1);
  return {
    session,
    cwd: events.find(event => event.type === 'session')?.cwd ?? null,
    state: openApprovals.length ? 'approval-pending' : started > turnEnds.length ? 'running' : 'idle',
    turns: { started, ended: turnEnds.length, lastEnd: turnEnds.at(-1)?.data?.reason?.kind ?? null },
    steps: count('step/end'),
    toolCalls: calls.size,
    toolErrors: events.filter(event => event.type === 'tool/result' && event.data?.message?.isError).length,
    tools,
    approvals: { asked: count('approval/asked'), decided: decided.length,
      outcomes: decided.map(event => String(event.data?.outcome)) },
    openApprovals,
    lastEvent: last?.type ?? null,
    lastEventTime: typeof last?.time === 'number' ? last.time : null,
  };
}

/** Parse decompressed Session V4 JSONL, skipping a torn final line from a live writer. */
export function parseSessionText(text: string): SessionEvent[] {
  return text.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as SessionEvent]; } catch { return []; }
  });
}

export type SessionArchive = { session: string; path: string; mtimeMs: number };

/** List every Session V4 archive under a DSH home, newest first. */
export function listSessionArchives(dshHome: string): SessionArchive[] {
  const found: SessionArchive[] = [];
  const pending = [join(dshHome, 'sessions')];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name === 'session.v4.jsonl.zstd') {
        found.push({ session: directory.split('/').at(-1)!, path, mtimeMs: statSync(path).mtimeMs });
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Read one archive with the system zstd decoder. */
export function readSessionArchive(path: string): SessionEvent[] {
  const result = spawnSync('zstdcat', [path], { encoding: 'utf8', timeout: 30_000, maxBuffer: 512_000_000 });
  if (result.error) throw result.error;
  return parseSessionText(result.stdout ?? '');
}

/** Pick an archive by exact session id, or the newest one whose recorded workspace is cwd. */
export function findSession(dshHome: string, options: { session?: string; cwd?: string }): SessionArchive | undefined {
  const archives = listSessionArchives(dshHome);
  if (options.session) return archives.find(archive => archive.session === options.session);
  if (!options.cwd) return archives[0];
  return archives.find(archive => {
    const first = readSessionArchive(archive.path)[0];
    return first?.type === 'session' && first.cwd === options.cwd;
  });
}
