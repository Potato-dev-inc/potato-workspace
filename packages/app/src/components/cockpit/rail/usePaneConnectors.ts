// The tool servers (MCP connectors) a chat has used. The app has no list of what is installed per chat, so this reads
// the chat itself: a tool call named mcp__<server>__<tool> means that server is connected and answering. The count of
// tools is the distinct tools seen so far (it grows as the chat uses more of them).
import { useMemo } from 'react';
import type { ChatTurn } from '../../../lib/sessionChatModel';

export interface PaneConnector {
  name: string;
  tools: number;
  ok: boolean;
}

const PREFIX = /^mcp__(.+?)__(.+)$/;

const pretty = (id: string): string =>
  id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

export function connectorsFromTurns(turns: readonly ChatTurn[]): PaneConnector[] {
  const seen = new Map<string, Set<string>>();
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (step.kind !== 'tool') continue;
      const m = PREFIX.exec(step.call.name);
      if (!m) continue;
      const set = seen.get(m[1]) ?? new Set<string>();
      set.add(m[2]);
      seen.set(m[1], set);
    }
  }
  return [...seen.entries()].map(([id, tools]) => ({ name: pretty(id), tools: tools.size, ok: true }));
}

export function usePaneConnectors(turns: readonly ChatTurn[]): PaneConnector[] {
  return useMemo(() => connectorsFromTurns(turns), [turns]);
}
