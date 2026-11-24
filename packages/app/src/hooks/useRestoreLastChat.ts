// After a restart, the chat that was open comes back: a chat of this PC as soon as it is listed, a chat of another PC once that PC is
// online and lists it. Quietly gives up (the app shows what it always showed) when the chat is not there after a while, or when the
// person already clicked or typed something.
import { useEffect, useRef } from 'react';

const KEY = 'pm.lastChat';
/** How long a chat is waited for (a far PC may need a minute to answer after the start). */
export const RESTORE_WAIT_MS = 90_000;

const read = (): string | null => {
  try {
    return window.localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
};

export function useRestoreLastChat({ open, has, openChat }: { /** The chat that is open now (a pane id, or a far chat's `dev:<node>:<id>` key); null when none. */ open: string | null; /** Whether this chat is listed now. */ has: (key: string) => boolean; /** Opens it; false when it could not. */ openChat: (key: string) => boolean }): void {
  const want = useRef<string | null | undefined>(undefined);
  if (want.current === undefined) want.current = read();
  const touched = useRef(false);
  const latest = useRef({ has, openChat });
  latest.current = { has, openChat };

  useEffect(() => {
    const mark = () => (touched.current = true);
    window.addEventListener('pointerdown', mark, true);
    window.addEventListener('keydown', mark, true);
    const giveUp = window.setTimeout(() => (want.current = null), RESTORE_WAIT_MS);
    return () => {
      window.removeEventListener('pointerdown', mark, true);
      window.removeEventListener('keydown', mark, true);
      window.clearTimeout(giveUp);
    };
  }, []);

  useEffect(() => {
    if (want.current && touched.current) want.current = null;
    if (!want.current) {
      if (open) {
        try {
          window.localStorage.setItem(KEY, open);
        } catch {
          /* no storage here */
        }
      }
      return;
    }
    // Still waiting for the saved chat: what the app opened by itself meanwhile is not remembered over it.
    const key = want.current;
    if (latest.current.has(key) && latest.current.openChat(key)) want.current = null;
  });
}
