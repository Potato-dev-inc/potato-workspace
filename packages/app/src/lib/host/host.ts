// The seam between a screen and the PC it shows. The chat screen says three things to its backend: a command (`invoke`),
// "tell me when X happens" (`listen`), and (later) a few bridge reads. A `Host` is those verbs for ONE place: this PC
// (`local.ts`) or another PC over the PC link (`far.ts`). The screen never asks which one it has.

export type Place = { kind: 'local' } | { kind: 'pc'; node: string; name: string };

/** What this person may do at that place. The far PC still enforces it; this only decides what to draw disabled. */
export interface Caps {
  watch: boolean;
  message: boolean;
  answer: boolean;
  change: boolean;
  start: boolean;
  terminal: boolean;
  files_write: boolean;
  git_write: boolean;
  preview: boolean;
}

export const ALL_CAPS: Caps = { watch: true, message: true, answer: true, change: true, start: true, terminal: true, files_write: true, git_write: true, preview: true };
export const WATCH_CAPS: Caps = { watch: true, message: false, answer: false, change: false, start: false, terminal: false, files_write: false, git_write: false, preview: false };

export type Unlisten = () => void;

export interface Host {
  place: Place;
  /** False only where nothing can answer (the local host in a plain browser). A far host is always live. */
  readonly live: boolean;
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  /** `cb` gets the event's payload. */
  listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten>;
  caps: Caps;
  /** Whether this place answers the command `cmd`. This PC answers all of them; a far PC answers the rows of its call table. A control whose
   * command it does not answer is drawn disabled with `notYet`, never as a different control. Absent: yes. */
  can?(cmd: string): boolean;
  /** The one plain line a disabled control gives when `can` said no (the far PC's name in it). Absent on this PC. */
  notYet?: string;
  /** Why `cap` is off here, in one plain line, or null when it is on (always null on this PC). The control is drawn disabled with this as its reason. */
  denied?(cap: keyof Caps): string | null;
  /** Who a shared reader of a chat is keyed by, when the host object is made again for a change that is not the link (a far PC's level): the same `link`, the same reader. Absent: the host itself. */
  readonly link?: object;
  /** A far chat that ended while its PC was off: it shows what this PC last held and asks nothing of the far PC (no feed to open, nothing to send). */
  readonly ended?: boolean;
  /** Why this PC may not turn Force yes ON here (that PC does not count this one as its person's own), in one plain line; null when it may or the PC does not say. Absent on this PC. */
  forceYesDenied?(): Promise<string | null>;
}

// ---- The wire shape of one far call (the far side is `pclink/calls.rs`; keep both in step) ----
//   POST /pclink/call/<cmd>
//   body:     the SAME args object the Tauri command takes (camelCase keys, `{}` when none)
//   response: the SAME JSON the Tauri command returns (`null` for a command that returns nothing)
//   a refusal / failure: a non-2xx status with `{ "error": "<sentence>", "code"?: "DEVICE_NOT_ALLOWED" | ... }`
//   an event: an `app` frame on `GET /pclink/events`, data `{ "event": "<tauri event name>", "payload": <same payload> }`
export const PCLINK_CALL_PREFIX = '/pclink/call/';
export const pclinkCallPath = (cmd: string): string => `${PCLINK_CALL_PREFIX}${encodeURIComponent(cmd)}`;
/** The data of an `app` frame: one allowlisted Tauri event, forwarded as it is. */
export interface PclinkAppFrame {
  event: string;
  payload: unknown;
}
