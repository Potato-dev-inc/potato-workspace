// A per-chat read that the call queue cancelled (the chat on screen changed while it waited: `AbortError`, lib/ipc-guard.ts) is
// not an answer. It is made again while the caller still wants it, and when it stays cancelled the caller keeps what it shows
// instead of clearing it (a banner must never end up hidden or loading because of a read nobody sent).
import { isAbort } from './ipc-guard';

export const ABORT_RETRY_MS = 40;
export const ABORT_TRIES = 4;

/** Resolves to the read's answer, or `undefined` when it kept being cancelled (or `current()` stopped holding). Other errors throw. */
export async function readUnlessCancelled<T>(read: () => Promise<T>, current: () => boolean = () => true): Promise<T | undefined> {
  for (let i = 1; ; i++) {
    try {
      return await read();
    } catch (error) {
      if (!isAbort(error)) throw error;
      if (i >= ABORT_TRIES || !current()) return undefined;
      await new Promise((resolve) => setTimeout(resolve, ABORT_RETRY_MS * i));
      if (!current()) return undefined;
    }
  }
}
