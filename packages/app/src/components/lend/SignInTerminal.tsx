import { useCallback, useEffect, useRef } from 'react';
import { useTerminalSession } from '../../hooks/useTerminalSession';
import { tauri } from '../../lib/tauri';
import { PaneStreamManager, createOwnerReplayReader } from '../../terminal';
import type { PaneDataSubscriber } from '../../terminal/types';
import '../../styles/lend.css';

const readReplay = createOwnerReplayReader({
  readScreen: tauri.readScreenReplay,
  readRaw: tauri.readRawBuffer,
  pendingResize: tauri.pendingResize,
});

/**
 * The small terminal of the sign-in step: it shows ONE pane by its id. The pane is hidden (it is in no pane list), and the
 * terminal data events are not part of any list either, so this view owns its own stream and needs nothing from the
 * cockpit's pane registry. The PTY is sized to this box by the normal terminal session (the viewer grid and the PTY grid
 * must be the same), so the agent's sign-in screens are drawn for what the person sees.
 */
export function SignInTerminal({ paneId, label }: { paneId: string; label: string }) {
  const streams = useRef(new PaneStreamManager());
  useEffect(() => {
    let off = false;
    let unData: (() => void) | undefined;
    let unResize: (() => void) | undefined;
    void (async () => {
      const d = await tauri.onTerminalData((e) => streams.current.ingest(e.pane_id, e.data, e.offset));
      const r = await tauri.onPtyResized((e) => streams.current.ingestResize(e.pane_id, e.cols, e.rows, e.offset));
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
  }, []);
  const subscribePaneData = useCallback<PaneDataSubscriber>((id, cb, onResize) => streams.current.subscribe(id, cb, readReplay, onResize), []);
  const { containerRef } = useTerminalSession({ paneId, sessionKey: 0, subscribePaneData, syncPTYResize: true });
  return (
    <div className="lend-term" role="group" aria-label={label} data-testid="lend-signin-terminal">
      <div ref={containerRef} className="terminal-host lend-term-host" />
    </div>
  );
}
