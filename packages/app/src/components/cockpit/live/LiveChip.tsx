// The LIVE chip in a shared pane's header. It shows only for panes in the room. Its menu holds the room's
// Pause (or Resume) and Stop, so a pane can be stopped from where the person is looking.
import { useEffect, useRef, useState } from 'react';
import { liveRoomApi, type LiveRoomApi, type LiveStatus } from '../../../lib/live-room';
import { errorText, useLiveRoom, type LiveSubscribe } from './useLiveRoom';
import '../../../styles/cockpit-live.css';
import { Menu } from '../../common/Floating';

export function LiveChip({
  paneId,
  status: given,
  api = liveRoomApi,
  subscribe,
  onStopped,
}: {
  paneId: string;
  /** Pass the status when the parent already has it; otherwise the chip reads it itself. */
  status?: LiveStatus | null;
  api?: LiveRoomApi;
  subscribe?: LiveSubscribe;
  onStopped?: () => void;
}) {
  const own = useLiveRoom({ api, subscribe, enabled: given === undefined });
  const status = given === undefined ? own.status : given;
  const refresh = own.refresh;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);


  if (!status?.live || !status.paneIds.includes(paneId)) return null;

  const run = (what: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    setOpen(false);
    what()
      .then(() => {
        after?.();
        refresh();
      })
      .catch((err) => setError(errorText(err)));
  };

  return (
    <span className="ck-live-chip-wrap">
      <button
        ref={btn}
        type="button"
        className="ck-chip-label ck-live-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ck-live-dot" aria-hidden="true" />
        LIVE
      </button>
      {open && (
        <Menu anchorRef={btn} align="end" className="ck-live-chip-menu" label="Live Room" onClose={() => setOpen(false)}>
          {status.paused ? (
            <button type="button" role="menuitem" className="ck-live-menu-item" onClick={() => run(() => api.resume())}>
              Resume
            </button>
          ) : (
            <button type="button" role="menuitem" className="ck-live-menu-item" onClick={() => run(() => api.pause())}>
              Pause
            </button>
          )}
          <button type="button" role="menuitem" className="ck-live-menu-item is-stop" onClick={() => run(() => api.stop(), onStopped)}>
            Stop
          </button>
        </Menu>
      )}
      {error && (
        <span className="ck-live-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
