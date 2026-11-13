// The phone's connection, in one plain word (pure). The words come from what the phone can see: whether its own network is up,
// whether the PC answered lately, how long it has not, and whether the PC said "I do not know this phone".
//   connected    the PC answers.
//   reconnecting the PC did not answer a moment ago (under RECONNECT_MS): wait, nothing to do.
//   asleep       the PC has not answered for a while: asleep, or Potato Workspace is closed.
//   offline      this phone has no internet.
//   changed      the link was changed or the pairing is gone: pair again.

export type LinkKind = 'connected' | 'reconnecting' | 'asleep' | 'offline' | 'changed';

/** A silence shorter than this is "reconnecting"; a longer one is "asleep or closed". */
export const RECONNECT_MS = 20_000;

export interface LinkInput {
  /** `navigator.onLine`. */
  online: boolean;
  /** The PC answered its last health check. */
  ready: boolean;
  /** When the PC last stopped answering (ms), or null while it answers. */
  downSince: number | null;
  /** The PC refused this phone's token (401): the pairing is gone or the link changed. */
  authFailed: boolean;
  now: number;
}

export function linkKind({ online, ready, downSince, authFailed, now }: LinkInput): LinkKind {
  if (authFailed) return 'changed';
  if (!online) return 'offline';
  if (ready) return 'connected';
  if (downSince !== null && now - downSince >= RECONNECT_MS) return 'asleep';
  return 'reconnecting';
}

/** True while messages may leave the phone. */
export const canReach = (kind: LinkKind): boolean => kind === 'connected';

/** One entry of the list under Settings > Help. */
export interface LinkEvent {
  at: number;
  kind: LinkKind;
}

/** The list keeps this many entries, newest last. */
export const MAX_EVENTS = 20;

/** Adds an entry when the kind changed (a repeat of the same kind is not a new event). */
export function pushEvent(events: readonly LinkEvent[], kind: LinkKind, at: number): LinkEvent[] {
  const last = events[events.length - 1];
  if (last && last.kind === kind) return events as LinkEvent[];
  return [...events, { at, kind }].slice(-MAX_EVENTS);
}

/** "14:05" in the phone's own clock and language. */
export function clockOf(at: number): string {
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

const LS_EVENTS = 'pm.phone.linkEvents';

export function readEvents(): LinkEvent[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_EVENTS) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const kinds: LinkKind[] = ['connected', 'reconnecting', 'asleep', 'offline', 'changed'];
    return parsed
      .filter((e): e is LinkEvent => !!e && typeof e.at === 'number' && kinds.includes(e.kind))
      .slice(-MAX_EVENTS);
  } catch {
    return [];
  }
}

export function writeEvents(events: readonly LinkEvent[]): void {
  try {
    localStorage.setItem(LS_EVENTS, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    /* private mode */
  }
}
