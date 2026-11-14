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
import { readQuiet } from '../../lib/notify-store';
import { dueToInstall, forgetWhatsNew, rememberWhatsNew, tonightTarget, type UpdateWhen } from '../../lib/update-schedule';
import { nextSpeed, STALL_HINT_MS, type DownloadReading } from '../../lib/update-progress';

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
  /** The person chose "When they finish" or "Tonight": the page watches and installs only then. */
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
  /** What the waiting follows: "finish" (default) or "tonight". Null before a choice. */
  when: UpdateWhen | null;
  /** For "Tonight": the time (ms) it may install. */
  target: number | null;
  /** The bytes so far with the speed, or null before the first reading. */
  reading: DownloadReading | null;
  /** No new data for a while: the page says the download is slow or stopped. */
  stalled: boolean;
  error: string | null;
  /** The chats were brought back after a failed install. */
  reopened: boolean;
  /** Looks for an update. A quiet check (loud = false) never shows an error; a press on Check does. */
  check(loud?: boolean): Promise<void>;
  /** The press on Update (also Try again): downloads, then asks to restart when an agent is working. */
  update(): Promise<void>;
  /** The press on Restart now: stops the agents and installs. */
  restartNow(): Promise<void>;
  /** "When they finish": waits, and installs by itself once nobody is working. */
  restartWhenIdle(): void;
  /** "Tonight": waits for the quiet-hours start (02:00 without quiet hours), and for the agents to finish. */
  restartTonight(): void;
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
  const [reading, setReading] = useState<DownloadReading | null>(null);
  const [stalled, setStalled] = useState(false);
  const lastReading = useRef<{ downloaded: number; at: number } | null>(null);
  const speed = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reopened, setReopened] = useState(false);
  const [when, setWhen] = useState<UpdateWhen | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const offerRef = useRef<UpdateOffer | null>(null);
  offerRef.current = offer;
  const whenRef = useRef<UpdateWhen | null>(null);
  whenRef.current = when;
  const busyChats = useRef(0);
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
    async (confirmRunning: boolean, fromWait = false) => {
      working.current = true;
      setError(null);
      setReopened(false);
      setPercent(null);
      setReading(null);
      setStalled(false);
      lastReading.current = null;
      speed.current = null;
      setPhase(confirmRunning || fromWait ? 'installing' : 'downloading');
      let stopListening: (() => void) | undefined;
      try {
        if (!confirmRunning && transport.onProgress) {
          stopListening = await transport.onProgress((progress) => {
            if (!live.current) return;
            setPercent(progressPercent(progress));
            const at = Date.now();
            setStalled(false);
            speed.current = nextSpeed(lastReading.current, { downloaded: progress.downloaded, at }, speed.current);
            lastReading.current = { downloaded: progress.downloaded, at };
            setReading({ ...progress, speed: speed.current });
          }).catch(() => undefined);
        }
        // After the restart the page shows "What is new" once; remember it now, because a good install ends this page.
        if (offerRef.current) rememberWhatsNew({ version: offerRef.current.version, notes: offerRef.current.notes, chats: busyChats.current });
        await transport.install(confirmRunning);
        // The installer closes the app; if this page is still here the installer did not start.
        if (live.current) setPhase('installing');
      } catch (e) {
        if (!live.current) return;
        const code = updateErrorCode(e);
        forgetWhatsNew();
        if (code === 'UPDATE_RUNNING') {
          const info = await readBusy();
          busyChats.current = info.chats.length;
          setBusy(info);
          // A chosen wait goes on (an agent started in between); with no choice it is the Ready step.
          setPhase(whenRef.current ? 'waiting' : 'ready');
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

  // While downloading: no new reading for a while means slow or stopped (the backend gives up by itself and says so).
  useEffect(() => {
    if (phase !== 'downloading') return;
    const timer = window.setInterval(() => {
      const last = lastReading.current;
      if (last && Date.now() - last.at >= STALL_HINT_MS) setStalled(true);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [phase]);

  const update = useCallback(async () => {
    if (working.current) return;
    setWhen(null);
    setTarget(null);
    await run(false);
  }, [run]);

  /** The wait is over: install with what was downloaded. Never stops an agent (`confirmRunning` stays false). */
  const installWhenDue = useCallback(async () => {
    if (working.current) return;
    await run(false, true);
  }, [run]);

  const restartNow = useCallback(async () => {
    if (working.current) return;
    await run(true);
  }, [run]);

  const restartWhenIdle = useCallback(() => {
    setWhen('finish');
    setTarget(null);
    setPhase('waiting');
  }, []);

  const restartTonight = useCallback(() => {
    setWhen('tonight');
    setTarget(tonightTarget(Date.now(), readQuiet()));
    setPhase('waiting');
  }, []);

  // Ready while agents work: "When they finish" is the default, so nothing is stopped and nothing waits for a press.
  useEffect(() => {
    if (phase === 'ready' && busy.agents.length > 0 && when === null) restartWhenIdle();
  }, [phase, busy.agents.length, when, restartWhenIdle]);

  const reopenChats = useCallback(async () => {
    try {
      await transport.reopenChats?.();
      if (live.current) setReopened(true);
    } catch (e) {
      if (live.current) setError(plainUpdateError(e));
    }
  }, [transport]);

  // Waiting: look now and then. It installs when nobody is working (and, for Tonight, when the time has come). It never
  // stops an agent: if one started in between, the install is refused and the wait goes on.
  useEffect(() => {
    if (phase !== 'waiting' || when === null) return;
    const timer = window.setInterval(() => {
      void readBusy().then((info) => {
        if (!live.current) return;
        busyChats.current = info.chats.length;
        setBusy(info);
        if (!dueToInstall(when, Date.now(), target, info.agents.length)) return;
        void installWhenDue();
      });
    }, IDLE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [phase, when, target, readBusy, installWhenDue]);

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

  return { phase, failure, offer, busyAgents: busy.agents, busy, percent, reading, stalled, error, reopened, when, target, check, update, restartNow, restartWhenIdle, restartTonight, reopenChats };
}
