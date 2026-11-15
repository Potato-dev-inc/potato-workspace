// Polls the app for connections with an out-of-date tool list and reconnects one. The result is a new array only
// when it changed, so a screen that reads it does not render again for nothing.
import { useCallback, useEffect, useRef, useState } from 'react';
import { mcpReconnect, mcpToolsDrift, type ToolsDrift } from '../lib/mcp-drift';
import { errorSentence } from '../lib/sayError';

const POLL_MS = 15_000;

function same(a: ToolsDrift[], b: ToolsDrift[]): boolean {
  return a.length === b.length && a.every((x, i) => x.paneId === b[i].paneId && x.agentCatalog === b[i].agentCatalog && x.canReconnect === b[i].canReconnect);
}

export interface ToolsDriftState {
  rows: ToolsDrift[];
  /** The pane being reconnected right now (null = none). */
  busy: string | null;
  /** The plain sentence of the last failed reconnect, by pane (`''` for a program with no pane). */
  failed: Record<string, string>;
  reconnect: (paneId: string, fallbackError: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useToolsDrift(pollMs: number = POLL_MS): ToolsDriftState {
  const [rows, setRows] = useState<ToolsDrift[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await mcpToolsDrift();
      if (alive.current) setRows((prev) => (same(prev, next) ? prev : next));
    } catch {
      // The check itself failing is not worth a banner.
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [refresh, pollMs]);

  const reconnect = useCallback(
    async (paneId: string, fallbackError: string) => {
      setBusy(paneId);
      setFailed((prev) => {
        const { [paneId]: _gone, ...rest } = prev;
        return rest;
      });
      try {
        await mcpReconnect(paneId);
      } catch (err) {
        if (alive.current) setFailed((prev) => ({ ...prev, [paneId]: errorSentence(err, fallbackError) }));
      } finally {
        if (alive.current) setBusy(null);
      }
      await refresh();
    },
    [refresh],
  );

  return { rows, busy, failed, reconnect, refresh };
}
