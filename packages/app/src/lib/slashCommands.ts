// The "/" menu of a chat session over ACP, ready before the agent is. The agent only tells its commands
// (`available_commands_update`) after its session starts, which can take seconds, or never happens for a chat that was
// restored and not used yet. So the last list the agent sent is kept per agent and adapter version (this computer only),
// the app's own commands are always there, and a "Loading commands…" row shows while the agent has not answered.
import { useEffect, useMemo, useState } from 'react';
import type { AcpCommand } from './acpChat';

export const SLASH_CACHE_KEY = 'pm.slash.commands.v1';
/** The most agents kept; the least recently refreshed go first. */
const MAX_AGENTS = 24;
const MAX_COMMANDS = 80;

/** A command the app answers itself: picking it puts this prompt in the box. */
export const APP_COMMANDS: readonly AcpCommand[] = [
  { name: 'recap', description: 'A short recap of what we did so far', hint: null, fill: 'Give me a short recap of what we did so far, in a few plain lines.' },
  { name: 'next', description: 'Ask what to do next', hint: null, fill: 'What should we do next? Give me two or three options and say which you would pick.' },
];

interface Entry {
  version: string;
  commands: AcpCommand[];
  at: number;
}
type Cache = Record<string, Entry>;

const keyOf = (agent: string, version: string | null): string => `${agent}@${version ?? '*'}`;

function read(): Cache {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SLASH_CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Cache) : {};
  } catch {
    return {};
  }
}

function write(cache: Cache): void {
  try {
    const keys = Object.keys(cache).sort((a, b) => cache[b].at - cache[a].at).slice(0, MAX_AGENTS * 2);
    const kept: Cache = {};
    for (const k of keys) kept[k] = cache[k];
    localStorage.setItem(SLASH_CACHE_KEY, JSON.stringify(kept));
  } catch {
    // Storage is blocked: the menu works without the cache.
  }
}

const clean = (commands: readonly AcpCommand[]): AcpCommand[] =>
  commands.slice(0, MAX_COMMANDS).map((c) => ({ name: c.name, description: c.description, hint: c.hint ?? null }));

/** The saved list for this agent: the exact adapter version when known, else the newest one saved for the agent. */
export function cachedCommands(agent: string, version: string | null): AcpCommand[] {
  const cache = read();
  return (cache[keyOf(agent, version)] ?? cache[keyOf(agent, null)])?.commands ?? [];
}

/** Keep what the agent just sent (under its version and as the agent's newest list). An empty list is not kept. */
export function rememberCommands(agent: string, version: string | null, commands: readonly AcpCommand[], now = Date.now()): void {
  if (!agent || commands.length === 0) return;
  const cache = read();
  const entry: Entry = { version: version ?? '', commands: clean(commands), at: now };
  if (version) cache[keyOf(agent, version)] = entry;
  cache[keyOf(agent, null)] = entry;
  write(cache);
}

/** The app's commands the agent has no command of the same name for, after the agent's own. */
export function withAppCommands(agent: readonly AcpCommand[]): AcpCommand[] {
  const taken = new Set(agent.map((c) => c.name.replace(/^\/+/, '').toLowerCase()));
  return [...agent, ...APP_COMMANDS.filter((c) => !taken.has(c.name))];
}

export interface SlashMenu {
  commands: AcpCommand[];
  /** The agent has not sent its list yet and nothing is saved: the menu shows "Loading commands…". */
  loading: boolean;
}

/**
 * What the "/" menu offers now. `live` is the agent's list (undefined or empty until its session starts), `waiting`
 * says the session is still starting, `version` is the adapter's version once known.
 */
export function useSlashCommands(agent: string, version: string | null, live: readonly AcpCommand[] | undefined, waiting: boolean): SlashMenu {
  const [saved, setSaved] = useState<AcpCommand[]>(() => (agent ? cachedCommands(agent, version) : []));
  useEffect(() => {
    if (!agent) return;
    if (live && live.length > 0) {
      rememberCommands(agent, version, live);
      setSaved(clean(live));
    } else {
      setSaved(cachedCommands(agent, version));
    }
  }, [agent, version, live]);
  return useMemo(() => {
    const agentList = live && live.length > 0 ? [...live] : saved;
    return { commands: withAppCommands(agentList), loading: agentList.length === 0 && waiting };
  }, [live, saved, waiting]);
}
