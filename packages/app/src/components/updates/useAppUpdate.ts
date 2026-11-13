// The update flow of the page: a quiet check, the offer, the download with its progress, a ready step that asks first when an
// agent is working, the restart, and the plain error. After an install that could not start but already stopped the agents,
// it says so and offers to reopen the chats.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkFailureOf,
  plainUpdateError,
  progressPercent,
  tauriUpdateTransport,
  updateErrorCode,
  type CheckFailure,
  type UpdateBusyInfo,
  type UpdateOffer,
  type UpdateTransport,
} from '../../lib/app-update';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'none'
  /** A channel could not be read and nothing newer came from the other one: never "up to date". */
  | 'failed'
  | 'available'
  | 'downloading'
  /** Downloaded and checked. Agents may still be working: Restart now asks nothing more, it is the confirmed press. */
  | 'ready'
  /** The person chose "When agents finish": the page watches and says when they are done. */
  | 'waiting'
  | 'installing'
  /** The installer could not start after the agents were stopped. */
  | 'stopped'
  | 'error';

export interface AppUpdateState {
  phase: UpdatePhase;
  /** Which channel could not be read (set with phase `failed`). */
  failure: CheckFailure | null;
  offer: UpdateOffer | null;
  busyAgents: string[];
  /** The split of `busyAgents` (empty lists when the backend does not say). */
  busy: UpdateBusyInfo;
  /** Whole percent of the download, or null while it is not known. */
  percent: number | null;
  error: string | null;
  /** The chats were brought back after a failed install. */
  reopened: boolean;
  /** Looks for an update. A quiet check (loud = false) never shows an error; a press on Check does. */
  check(loud?: boolean): Promise<void>;
  /** The press on Update (also Try again): downloads, then asks to restart when an agent is working. */
  update(): Promise<void>;
  /** The press on Restart now: stops the agents and installs. */
  restartNow(): Promise<void>;
  /** "When agents finish": waits and says when it is safe. */
  restartWhenIdle(): void;
  /** After a failed install: brings the stopped chats back. */
  reopenChats(): Promise<void>;
}

/** A quiet check at start and then every six hours. */
export const RECHECK_MS = 6 * 60 * 60 * 1000;
/** While waiting for the agents to finish, look this often. */
export const IDLE_POLL_MS = 10_000;

const NO_BUSY: UpdateBusyInfo = { agents: [], chats: [], terminals: [] };

export function useAppUpdate(transport: UpdateTransport = tauriUpdateTransport, auto = true): AppUpdateState {
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  const [failure, setFailure] = useState<CheckFailure | null>(null);
  const [busy, setBusy] = useState<UpdateBusyInfo>(NO_BUSY);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reopened, setReopened] = useState(false);
  const live = useRef(true);
  const working = useRef(false);

  const readBusy = useCallback(async (): Promise<UpdateBusyInfo> => {
    try {
      if (transport.busyInfo) return await transport.busyInfo();
      return { agents: await transport.busy(), chats: [], terminals: [] };
    } catch {
      return NO_BUSY;
    }
  }, [transport]);

  const check = useCallback(
    async (loud = false) => {
      if (working.current) return;
      if (loud) {
        setError(null);
        setPhase('checking');
      }
      try {
        const found = await transport.check();
        if (!live.current) return;
        setOffer(found);
        setFailure(null);
        setPhase(found ? 'available' : loud ? 'none' : 'idle');
      } catch (e) {
        if (!live.current) return;
        if (!loud) {
          setPhase((p) => (p === 'checking' ? 'idle' : p));
          return;
        }
        const failed = checkFailureOf(e);
        if (failed) {
          setFailure(failed);
          setPhase('failed');
          return;
        }
        setError(plainUpdateError(e));
        setPhase('error');
      }
    },
    [transport],
  );

  const run = useCallback(
    async (confirmRunning: boolean) => {
      working.current = true;
      setError(null);
      setReopened(false);
      setPercent(null);
      setPhase(confirmRunning ? 'installing' : 'downloading');
      let stopListening: (() => void) | undefined;
      try {
        if (!confirmRunning && transport.onProgress) {
          stopListening = await transport.onProgress((progress) => {
            if (live.current) setPercent(progressPercent(progress));
          }).catch(() => undefined);
        }
        await transport.install(confirmRunning);
        // The installer closes the app; if this page is still here the installer did not start.
        if (live.current) setPhase('installing');
      } catch (e) {
        if (!live.current) return;
        const code = updateErrorCode(e);
        if (code === 'UPDATE_RUNNING') {
          setBusy(await readBusy());
          setPhase('ready');
          return;
        }
        setError(plainUpdateError(e));
        setPhase(code === 'UPDATE_STOPPED' ? 'stopped' : 'error');
      } finally {
        stopListening?.();
        working.current = false;
      }
    },
    [readBusy, transport],
  );

  const update = useCallback(async () => {
    if (working.current) return;
    await run(false);
  }, [run]);

  const restartNow = useCallback(async () => {
    if (working.current) return;
    await run(true);
  }, [run]);

  const restartWhenIdle = useCallback(() => setPhase('waiting'), []);

  const reopenChats = useCallback(async () => {
    try {
      await transport.reopenChats?.();
      if (live.current) setReopened(true);
    } catch (e) {
      if (live.current) setError(plainUpdateError(e));
    }
  }, [transport]);

  // "When agents finish": look now and then; when nobody is working, go back to Ready with nothing to warn about.
  useEffect(() => {
    if (phase !== 'waiting') return;
    const timer = window.setInterval(() => {
      void readBusy().then((info) => {
        if (!live.current || info.agents.length > 0) return;
        setBusy(info);
        setPhase((p) => (p === 'waiting' ? 'ready' : p));
      });
    }, IDLE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [phase, readBusy]);

  useEffect(() => {
    live.current = true;
    if (!auto) {
      return () => {
        live.current = false;
      };
    }
    void check(false);
    const timer = window.setInterval(() => void check(false), RECHECK_MS);
    return () => {
      live.current = false;
      window.clearInterval(timer);
    };
  }, [auto, check]);

  return { phase, failure, offer, busyAgents: busy.agents, busy, percent, error, reopened, check, update, restartNow, restartWhenIdle, reopenChats };
}
