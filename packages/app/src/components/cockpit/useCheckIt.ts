// State of "Check it in the browser" for one pane: whether the button shows, the check running, and its answer.
import { useCallback, useEffect, useRef, useState } from 'react';
import { browserCheckApi, checkError, type BrowserCheckApi, type CheckReport } from '../../lib/browser-check';

export interface CheckIt {
  /** The Labs switch is on and the pane has a page to check. */
  available: boolean;
  busy: boolean;
  report: CheckReport | null;
  error: string | null;
  /** The card is showing (running, answered or failed). */
  shown: boolean;
  run: () => void;
  close: () => void;
}

export function useCheckIt(paneId: string, url: string | null, fallbackError: string, api: BrowserCheckApi = browserCheckApi): CheckIt {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CheckReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const token = useRef(0);

  useEffect(() => {
    token.current += 1;
    setBusy(false);
    setReport(null);
    setError(null);
    setOpened(false);
  }, [paneId]);

  useEffect(() => {
    if (!url) {
      setAvailable(false);
      return;
    }
    let live = true;
    api
      .enabled()
      .then((on) => live && setAvailable(on))
      .catch(() => live && setAvailable(false));
    return () => {
      live = false;
    };
  }, [url, api]);

  const run = useCallback(() => {
    if (!url || busy) return;
    const mine = ++token.current;
    setOpened(true);
    setBusy(true);
    setError(null);
    api
      .run(paneId, url)
      .then((r) => {
        if (token.current !== mine) return;
        setReport(r);
        setBusy(false);
      })
      .catch((e: unknown) => {
        if (token.current !== mine) return;
        setReport(null);
        setError(checkError(e, fallbackError));
        setBusy(false);
      });
  }, [api, busy, fallbackError, paneId, url]);

  const close = useCallback(() => {
    token.current += 1;
    setOpened(false);
    setBusy(false);
    setReport(null);
    setError(null);
  }, []);

  return { available: available && !!url, busy, report, error, shown: opened, run, close };
}
