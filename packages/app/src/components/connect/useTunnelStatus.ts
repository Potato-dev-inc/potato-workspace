// Reads how this PC is reached and keeps reading it, so the Connect screens never show a stale address.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TunnelStatus } from '../../lib/tauri-types';
import type { TunnelApi } from '../settings/TunnelSection';

export function useTunnelStatus(api: TunnelApi, everyMs = 3000): [TunnelStatus | null | undefined, (s: TunnelStatus) => void] {
  // undefined = not read yet; null = no desktop shell.
  const [status, setStatus] = useState<TunnelStatus | null | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const read = () =>
      void Promise.resolve()
        .then(() => api.getStatus())
        .then((s) => alive.current && setStatus(s))
        .catch(() => undefined);
    read();
    const id = window.setInterval(read, everyMs);
    return () => {
      alive.current = false;
      window.clearInterval(id);
    };
  }, [api, everyMs]);
  const set = useCallback((s: TunnelStatus) => setStatus(s), []);
  return [status, set];
}
