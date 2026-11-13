// The phone's connection word and its last events. It reads what PwaApp already knows (the PC's health check) plus the phone's own
// network, and adds the silence timer: after RECONNECT_MS without an answer the word turns from "Reconnecting" into "PC asleep".
import { useEffect, useRef, useState } from 'react';
import { linkKind, pushEvent, readEvents, writeEvents, RECONNECT_MS, type LinkEvent, type LinkKind } from '../lib/phone-link';

export interface PhoneLink {
  kind: LinkKind;
  /** When the PC last answered (ms), or null before it ever did. */
  lastOkAt: number | null;
  /** Newest last, at most 20. */
  events: LinkEvent[];
  /** The PC answers again after a trouble: "Connected" shows for a moment. */
  recovered: boolean;
}

/** How long "Connected" stays after a trouble. */
export const RECOVERED_MS = 3000;

const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

export function usePhoneLink(ready: boolean, authFailed: boolean): PhoneLink {
  const [now, setNow] = useState(() => Date.now());
  const [net, setNet] = useState(online);
  const [downSince, setDownSince] = useState<number | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [events, setEvents] = useState<LinkEvent[]>(readEvents);
  const readyRef = useRef(ready);
  const [recovered, setRecovered] = useState(false);
  const lastKind = useRef<LinkKind | null>(null);
  const everConnected = useRef(false);

  useEffect(() => {
    const up = () => setNet(true);
    const down = () => setNet(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // When the PC stops answering, start counting; when it answers again, forget the silence.
  useEffect(() => {
    readyRef.current = ready;
    const at = Date.now();
    setNow(at);
    if (ready) {
      setDownSince(null);
      setLastOkAt(at);
    } else {
      setDownSince((cur) => cur ?? at);
    }
  }, [ready]);

  // The word changes after RECONNECT_MS of silence with no other event, so the clock ticks only while the PC is quiet.
  useEffect(() => {
    if (ready) return;
    const timer = window.setInterval(() => setNow(Date.now()), Math.min(5000, RECONNECT_MS / 4));
    return () => window.clearInterval(timer);
  }, [ready]);

  const kind = linkKind({ online: net, ready, downSince, authFailed, now });

  useEffect(() => {
    setEvents((cur) => {
      const next = pushEvent(cur, kind, Date.now());
      if (next !== cur) writeEvents(next);
      return next;
    });
  }, [kind]);

  useEffect(() => {
    const before = lastKind.current;
    lastKind.current = kind;
    const had = everConnected.current;
    if (kind === 'connected') everConnected.current = true;
    // The first connection of a visit is not a recovery: "Connected" shows only after a trouble that followed a connection.
    if (kind !== 'connected' || before === null || before === 'connected' || !had) return;
    setRecovered(true);
    const timer = window.setTimeout(() => setRecovered(false), RECOVERED_MS);
    return () => window.clearTimeout(timer);
  }, [kind]);

  return { kind, lastOkAt, events, recovered };
}
