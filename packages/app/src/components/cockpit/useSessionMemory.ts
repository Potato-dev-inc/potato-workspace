// Puts the cockpit back where the last run left it (session-memory.ts): the selected pane on its tab, and a list of
// the terminal agents that did not survive the restart. Terminal agents are never started on their own.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PaneInfo } from '../../lib/tauri-types';
import { isCompanionPaneId } from './companion/model';
import { rememberedTabOf, seedRememberedTab } from './PaneView';
import {
  endedTerminals,
  patchSessionMemory,
  readSessionMemory,
  rememberableTerminal,
  writeSessionMemory,
  type RememberedTerminal,
} from './session-memory';

/** How long a vanished pane waits before it is forgotten: a quit closes every pane, and that must not count. */
export const FORGET_DELAY_MS = 1500;

export interface SessionMemoryApi {
  /** Terminal agents from the last run that are gone and not yet reopened or dismissed. */
  ended: RememberedTerminal[];
  dismiss: () => void;
  reopen: () => Promise<void>;
  /** Selects the pane (on its tab) the last run ended on, if it still exists. True when it did. */
  restoreSelection: () => boolean;
}

export function useSessionMemory(opts: {
  ready: boolean;
  selectedId: string | null;
  panes: ReadonlyMap<string, { info: PaneInfo }>;
  select: (id: string) => void;
  newAgent: (agentId: string, accountId?: string, isolated?: boolean, projectPath?: string, model?: string, how?: 'terminal') => Promise<string | null>;
}): SessionMemoryApi {
  const { ready, selectedId, panes, select, newAgent } = opts;
  // Read once, before anything is written: this is the last run.
  const previous = useRef(readSessionMemory());
  const armed = useRef(false);
  const [ended, setEnded] = useState<RememberedTerminal[] | null>(null);

  useEffect(() => {
    if (ready && ended === null) setEnded(endedTerminals(previous.current, (id) => panes.has(id)));
  }, [ready]);

  // The selection, with its tab. Only after the restore has run, so the empty start does not erase it.
  useEffect(() => {
    if (!ready || !armed.current) return;
    const ok = selectedId !== null && !isCompanionPaneId(selectedId) && panes.has(selectedId);
    patchSessionMemory((m) => ({ ...m, selected: ok ? { id: selectedId, tab: rememberedTabOf(selectedId) } : null }));
  }, [ready, selectedId]);

  // The open terminal agents, plus the ended ones that are still waiting on a Reopen or a dismiss.
  const keep = ended ?? [];
  useEffect(() => {
    if (!ready || ended === null) return;
    const live = [...panes.values()].map((p) => rememberableTerminal(p.info)).filter((t): t is RememberedTerminal => t !== null);
    const liveIds = new Set(live.map((t) => t.id));
    const waiting = keep.filter((t) => !liveIds.has(t.id));
    const waitingIds = new Set(waiting.map((t) => t.id));
    const stored = readSessionMemory();
    const next = { ...stored, terminals: [...live, ...waiting] };
    if (JSON.stringify(next.terminals) === JSON.stringify(stored.terminals)) return;
    const dropsOne = stored.terminals.some((t) => !liveIds.has(t.id) && !waitingIds.has(t.id));
    if (!dropsOne) {
      writeSessionMemory(next);
      return;
    }
    const t = window.setTimeout(() => writeSessionMemory({ ...readSessionMemory(), terminals: next.terminals }), FORGET_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [ready, ended, panes]);

  const restoreSelection = useCallback(() => {
    armed.current = true;
    const want = previous.current.selected;
    if (!want || !panes.has(want.id) || isCompanionPaneId(want.id)) return false;
    seedRememberedTab(want.id, want.tab);
    select(want.id);
    return true;
  }, [panes, select]);

  const dismiss = useCallback(() => setEnded([]), []);
  const reopen = useCallback(async () => {
    for (const t of keep) {
      // These were terminals: they come back as terminals, whatever "Show terminals" says.
      const id = await newAgent(t.agent, t.account, false, t.cwd || undefined, undefined, 'terminal');
      if (id) setEnded((cur) => (cur ?? []).filter((x) => x.id !== t.id));
    }
  }, [keep, newAgent]);

  return { ended: keep, dismiss, reopen, restoreSelection };
}

