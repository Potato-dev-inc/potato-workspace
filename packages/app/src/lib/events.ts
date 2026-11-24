// One real Tauri listen per event name, shared by every subscriber (a chat open used to register ~38 listeners, each one
// an IPC round trip to start and another to stop). Same call shape as `listen` from `@tauri-apps/api/event`.
import { listen as tauriListen, type Event, type UnlistenFn } from '@tauri-apps/api/event';

type Handler = (event: Event<never>) => void;
interface Entry {
  subs: Set<{ h: Handler }>;
  off: UnlistenFn | null;
  gone: boolean;
  ready: Promise<void>;
}
const entries = new Map<string, Entry>();

export function listen<T>(event: string, handler: (event: Event<T>) => void): Promise<UnlistenFn> {
  let entry = entries.get(event);
  let first: Promise<UnlistenFn> | null = null;
  if (!entry) {
    const made: Entry = { subs: new Set(), off: null, gone: false, ready: Promise.resolve() };
    first = tauriListen<never>(event, (e) => {
      for (const s of [...made.subs]) {
        try {
          s.h(e);
        } catch (error) {
          console.error('listener for '+event+' threw', error);
        }
      }
    });
    made.ready = first.then(
      (off) => {
        if (made.gone) off();
        else made.off = off;
      },
      (error) => {
        if (entries.get(event) === made) entries.delete(event);
        throw error;
      },
    );
    // The first subscriber waits on `first` itself, so a failed listen would leave this rejection unhandled; later ones still see it.
    made.ready.catch(() => undefined);
    entries.set(event, made);
    entry = made;
  }
  const mine = entry;
  const sub = { h: handler as unknown as Handler };
  mine.subs.add(sub);
  const unsubscribe = () => {
    if (!mine.subs.delete(sub) || mine.subs.size > 0) return;
    // The last one left: really unlisten (a listen still in flight unlistens the moment it lands).
    mine.gone = true;
    if (entries.get(event) === mine) entries.delete(event);
    mine.off?.();
    mine.off = null;
  };
  // The first subscriber waits on the real listen itself (no extra hop); later ones on the entry's.
  return (first ?? mine.ready).then(
    () => unsubscribe,
    (error) => {
      mine.subs.delete(sub);
      throw error;
    },
  );
}

/** Tests only: forget every open listen (a test's mock listen is not the last one's). */
export function resetEventHub(): void {
  entries.clear();
}

/** Tests only: how many real listens are open. */
export const openListens = (): number => entries.size;
