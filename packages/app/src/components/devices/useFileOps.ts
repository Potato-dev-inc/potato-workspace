// What Files, the transfer list and the Get it card share: start a copy or a send, ask once when the name is taken,
// and read this device's transfers from the devices state. A far answer is plain data (`ok:false`), never thrown.
import { useCallback, useRef, useState } from 'react';
import { copyId, isExists, isFarError } from '../../lib/deviceFiles';
import { clipText, devicesApi, type CopyResult, type DevicesApi, type OnExists, type Transfer } from '../../lib/devices';
import { errorSentence } from '../../lib/sayError';
import { useDevices } from './useDevices';

export interface FileOps {
  /** The name that is already taken (untrusted text), while the person is asked. */
  question: string | null;
  error: string | null;
  busy: boolean;
  /** The id of the last transfer this started. */
  lastId: number | null;
  /** Starts with `ask`. */
  run: (op: (mode: OnExists) => Promise<CopyResult>) => void;
  /** The person's answer: Replace it, Keep both, or Cancel (null). `replace` is only ever sent from here. */
  answer: (mode: 'replace' | 'both' | null) => void;
}

export function useFileOps(): FileOps {
  const [question, setQuestion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastId, setLastId] = useState<number | null>(null);
  const pending = useRef<((mode: OnExists) => Promise<CopyResult>) | null>(null);

  const go = useCallback(async (mode: OnExists) => {
    const op = pending.current;
    if (!op) return;
    setBusy(true);
    try {
      const r = await op(mode);
      if (isFarError(r)) {
        pending.current = null;
        setQuestion(null);
        setError(clipText(r.error, 300) || '?');
      } else if (isExists(r)) {
        setQuestion(clipText(r.name, 200));
      } else {
        pending.current = null;
        setQuestion(null);
        setLastId(copyId(r));
      }
    } catch (e) {
      pending.current = null;
      setQuestion(null);
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const run = useCallback(
    (op: (mode: OnExists) => Promise<CopyResult>) => {
      pending.current = op;
      setError(null);
      setQuestion(null);
      void go('ask');
    },
    [go],
  );

  const answer = useCallback(
    (mode: 'replace' | 'both' | null) => {
      if (mode === null) {
        pending.current = null;
        setQuestion(null);
        return;
      }
      setQuestion(null);
      void go(mode);
    },
    [go],
  );

  return { question, error, busy, lastId, run, answer };
}

/** This device's transfers, newest first, kept current by the devices state. */
export function useTransfers(api: DevicesApi = devicesApi, node: string): Transfer[] {
  const { view } = useDevices(api);
  return (view?.transfers ?? []).filter((x) => x.node === node);
}
