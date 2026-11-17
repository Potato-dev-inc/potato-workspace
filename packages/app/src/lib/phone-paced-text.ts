// Smooth text. The PC sends the agent's words in jumps (the phone asks every second or so); the phone lets them out a share
// of the backlog every 24 ms, never slower than the PC sends, and cuts at a space so a word never shows half-made.
// Pure: the hook (hooks/usePacedText.ts) owns the timer. Shown at once under reduced motion or when the chat is not live.

/** How often a tick runs (ms). */
export const PACED_TICK_MS = 24;
/** A tick shows at least this many letters of the backlog. */
const MIN_STEP = 2;
/** A tick shows about 1/SHARE of the backlog, so a big jump is out in about a second, and a small one is not slower than it arrives. */
const SHARE = 26;
/** If a space is this close after the cut, the cut moves to it. */
const SPACE_REACH = 10;

/** How many letters of `target` to show after one more tick, given `shown` now. Never goes back; never past the end. */
export function pacedNext(shown: number, target: string): number {
  const len = target.length;
  const from = Math.min(Math.max(0, shown), len);
  if (from >= len) return len;
  const cut = from + Math.max(MIN_STEP, Math.ceil((len - from) / SHARE));
  if (cut >= len) return len;
  const space = target.indexOf(' ', cut);
  return space > -1 && space - cut < SPACE_REACH ? space + 1 : cut;
}

/** What to put on screen: the whole text when not pacing, otherwise the first `shown` letters. */
export function pacedSlice(target: string, shown: number, active: boolean): string {
  return active ? target.slice(0, Math.min(Math.max(0, shown), target.length)) : target;
}

/** True when there is still backlog to let out. */
export function pacedBehind(shown: number, target: string): boolean {
  return shown < target.length;
}
