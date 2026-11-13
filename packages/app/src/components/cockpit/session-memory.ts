// What the cockpit remembers between starts: the selected pane (and the tab it was on), and the terminal agents
// that were open, so a restart can say which ones ended. Kept in localStorage next to the split memory.
// Every storage call is wrapped in try/catch: a blocked or full storage just means no memory.
import { t } from '../../i18n';
import { ACP_LANE } from '../../lib/acpChat';
import type { PaneInfo } from '../../lib/tauri-types';
import { isCompanionPaneId } from './companion/model';

export const SESSION_MEMORY_KEY = 'pm.cockpit.session';

export interface RememberedTerminal {
  id: string;
  agent: string;
  cwd: string;
  account?: string;
  title?: string;
}

export interface SessionMemory {
  /** The pane that was selected and the tab it was on (null: the Inbox, or nothing). */
  selected: { id: string; tab?: string } | null;
  /** The terminal agents that were open. Chat panes are not here: they come back on their own. */
  terminals: RememberedTerminal[];
}

const EMPTY: SessionMemory = { selected: null, terminals: [] };

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Reads the stored text. Anything that is not the expected shape is dropped piece by piece, never thrown. */
export function parseSessionMemory(raw: string | null): SessionMemory {
  if (!raw) return EMPTY;
  try {
    const v = JSON.parse(raw) as { selected?: unknown; terminals?: unknown } | null;
    if (!v || typeof v !== 'object') return EMPTY;
    const sel = v.selected as { id?: unknown; tab?: unknown } | null | undefined;
    const selected = sel && str(sel.id) ? { id: sel.id, ...(str(sel.tab) ? { tab: sel.tab } : {}) } : null;
    const terminals: RememberedTerminal[] = [];
    const seen = new Set<string>();
    if (Array.isArray(v.terminals)) {
      for (const t of v.terminals as Array<Record<string, unknown> | null>) {
        if (!t || !str(t.id) || !str(t.agent) || typeof t.cwd !== 'string' || seen.has(t.id)) continue;
        seen.add(t.id);
        terminals.push({
          id: t.id,
          agent: t.agent,
          cwd: t.cwd,
          ...(str(t.account) ? { account: t.account } : {}),
          ...(str(t.title) ? { title: t.title } : {}),
        });
      }
    }
    return { selected, terminals };
  } catch {
    return EMPTY;
  }
}

export function readSessionMemory(): SessionMemory {
  try {
    return parseSessionMemory(localStorage.getItem(SESSION_MEMORY_KEY));
  } catch {
    return EMPTY;
  }
}

export function writeSessionMemory(memory: SessionMemory): void {
  try {
    localStorage.setItem(SESSION_MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // Storage is blocked or full: nothing is remembered, nothing else changes.
  }
}

/** Changes the stored memory in place (read, change, write). */
export function patchSessionMemory(change: (m: SessionMemory) => SessionMemory): void {
  writeSessionMemory(change(readSessionMemory()));
}

/** Drops one terminal from the memory (the person closed it themselves). */
export function forgetTerminal(id: string): void {
  patchSessionMemory((m) => (m.terminals.some((t) => t.id === id) ? { ...m, terminals: m.terminals.filter((t) => t.id !== id) } : m));
}

/** The tab was changed on the selected pane: keep it with the selection. */
export function rememberSelectedTab(id: string, tab: string): void {
  patchSessionMemory((m) => (m.selected?.id === id ? { ...m, selected: { id, tab } } : m));
}

/** A terminal agent the person started and can reopen: not a chat, not a helper, not a companion. */
export function rememberableTerminal(info: PaneInfo): RememberedTerminal | null {
  if (info.lane === ACP_LANE || info.parent_pane_id || isCompanionPaneId(info.id) || !info.agent_type) return null;
  return {
    id: info.id,
    agent: info.agent_type,
    cwd: info.cwd ?? '',
    ...(info.account ? { account: info.account } : {}),
    ...(info.title ? { title: info.title } : {}),
  };
}

/** The remembered terminals that are not in the pane list any more. */
export function endedTerminals(memory: SessionMemory, hasPane: (id: string) => boolean): RememberedTerminal[] {
  return memory.terminals.filter((t) => !hasPane(t.id));
}

/** The line shown for the terminals that ended with the last restart. */
export function endedLine(count: number): string {
  return t('risk.ended', { count });
}
