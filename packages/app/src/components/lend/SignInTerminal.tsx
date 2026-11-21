import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTerminalSession } from '../../hooks/useTerminalSession';
import { useHost } from '../../lib/host/context';
import { terminalFeedFor } from '../../lib/host/terminalFeed';
import { PaneStreamManager, createOwnerReplayReader } from '../../terminal';
import type { PaneDataSubscriber } from '../../terminal/types';
import '../../styles/lend.css';

/**
 * The small terminal of the sign-in step: it shows ONE pane by its id. The pane is hidden (it is in no pane list), and the
 * terminal data events are not part of any list either, so this view owns its own stream and needs nothing from the
 * cockpit's pane registry. The PTY is sized to this box by the normal terminal session (the viewer grid and the PTY grid
 * must be the same), so the agent's sign-in screens are drawn for what the person sees.
 */
export function SignInTerminal({ paneId, label }: { paneId: string; label: string }) {
  const host = useHost();
  const feed = useMemo(() => terminalFeedFor(host), [host]);
  const readReplay = useMemo(() => createOwnerReplayReader(feed.replay), [feed]);
  const streams = useRef(new PaneStreamManager());
  useEffect(() => {
    let off = false;
    let unData: (() => void) | undefined;
    let unResize: (() => void) | undefined;
    void (async () => {
      const d = await feed.onData((e) => streams.current.ingest(e.pane_id, e.data, e.offset));
      const r = await feed.onResized((e) => streams.current.ingestResize(e.pane_id, e.cols, e.rows, e.offset));
      if (off) {
        d();
        r();
      } else {
        unData = d;
        unResize = r;
      }
    })();
    return () => {
      off = true;
      unData?.();
      unResize?.();
    };
  }, [feed]);
  const subscribePaneData = useCallback<PaneDataSubscriber>((id, cb, onResize) => streams.current.subscribe(id, cb, readReplay, onResize), [readReplay]);
  const transport = useMemo(() => feed.transport?.(paneId), [feed, paneId]);
  const { containerRef } = useTerminalSession({ paneId, sessionKey: 0, subscribePaneData, syncPTYResize: true, transport });
  return (
    <div className="lend-term" role="group" aria-label={label} data-testid="lend-signin-terminal">
      <div ref={containerRef} className="terminal-host lend-term-host" />
    </div>
  );
}
