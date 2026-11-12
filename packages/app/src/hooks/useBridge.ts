import { useEffect, useRef, useState } from 'react';
import { findBridgeUrl, makeBridgeClient, subscribeBridgeEvents, type BridgeClient } from '../lib/bridge';
import { loadBridgeLocalSecret } from '../lib/bridge-local-secret';
import type { McpLogEntry, PaneInfo } from '@potato-workspace/shared';

export interface BridgeApi {
  client: BridgeClient | null;
  panesFromBridge: PaneInfo[];
  externalLogs: McpLogEntry[];
  isReady: boolean;
  error: string | null;
  /** True when a bridge that was reachable stops answering. Clears on the next event. */
  connectionLost: boolean;
}

export function useBridge(bridgeUrl?: string): BridgeApi {
  const [client, setClient] = useState<BridgeClient | null>(null);
  const [panesFromBridge, setPanesFromBridge] = useState<PaneInfo[]>([]);
  const [externalLogs, setExternalLogs] = useState<McpLogEntry[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const clientRef = useRef<BridgeClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    async function tryConnect() {
      if (cancelled) return;
      const url = bridgeUrl ?? await findBridgeUrl();
      // The app's own key for the local bridge (S3); null outside the desktop app.
      await loadBridgeLocalSecret();
      if (cancelled) return;
      if (!url) {
        setError('Bridge not reachable. Is the Potato Workspace GUI running?');
        pollTimer = setTimeout(tryConnect, 2000);
        return;
      }
      const c = makeBridgeClient(url);
      clientRef.current = c;
      setClient(c);
      setIsReady(true);
      setError(null);
      unsub = subscribeBridgeEvents(
        url,
        (ev) => {
          setConnectionLost(false);
          if (ev.type === 'panes') setPanesFromBridge(ev.panes);
          if (ev.type === 'log') {
            setExternalLogs((prev) => [ev.entry, ...prev].slice(0, 500));
          }
        },
        () => {
          // SSE retries internally; this only records that the live connection dropped.
          setConnectionLost(true);
        },
      );
    }

    tryConnect();
    return () => {
      cancelled = true;
      unsub?.();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [bridgeUrl]);

  return {
    client,
    panesFromBridge,
    externalLogs,
    isReady,
    error,
    connectionLost,
  };
}
