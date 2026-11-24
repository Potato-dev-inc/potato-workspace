// "Your draft follows you": the half-written message of a chat is also kept by the PC (memory only, words only), so the phone
// and the PC can hand it to each other. This hook is the composer's side of it:
//  - when the box is EMPTY it asks the PC for the draft (when the box opens, and again when the window or the phone page comes
//    back to the front) and puts it in; it never replaces what is typed, and a draft that is the same as what this box last
//    sent the PC is its own echo and is ignored;
//  - what is typed goes to the PC a moment after the last key; emptying the box (a sent message, or Clear) goes at once;
//  - nothing but text: attachments never travel.
import { useEffect, useRef } from 'react';
import type { RemoteDraft } from '../lib/chatMore';
import { wasJustSent } from '../lib/composerDraft';

/** How long after the last key the draft is sent to the PC. */
export const REMOTE_DRAFT_MS = 800;

export function useRemoteDraft(remote: RemoteDraft | null | undefined, text: string, setText: (text: string) => void, paneKey?: string): void {
  const textRef = useRef(text);
  textRef.current = text;
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const setRef = useRef(setText);
  setRef.current = setText;
  /** What this box last gave the PC (`null`: nothing yet). */
  const sent = useRef<string | null>(null);
  const first = useRef(true);
  const pending = useRef<string | null>(null);
  const key = remote ? 'on' : 'off';
  const paneRef = useRef(paneKey);
  paneRef.current = paneKey;
  /** The sent message (or one being sent) is not a draft: neither the PC's copy nor the closing write may revive it. */
  const sentWords = (words: string) => !!paneRef.current && wasJustSent(paneRef.current, words);

  // Take the PC's draft into an empty box.
  useEffect(() => {
    if (!remote) return;
    let live = true;
    const take = () => {
      if (document.visibilityState === 'hidden' || textRef.current.trim() !== '') return;
      remote.read().then(
        (found) => {
          if (!live || !found || found.trim() === '' || found === sent.current || sentWords(found)) return;
          // Typed while the answer was on its way: the box is theirs.
          if (textRef.current.trim() !== '') return;
          sent.current = found;
          setRef.current(found);
        },
        () => undefined,
      );
    };
    take();
    window.addEventListener('focus', take);
    document.addEventListener('visibilitychange', take);
    return () => {
      live = false;
      window.removeEventListener('focus', take);
      document.removeEventListener('visibilitychange', take);
    };
  }, [remote, key]);

  // Give the PC what is typed.
  useEffect(() => {
    const send = remoteRef.current;
    if (!send) return;
    // The text the box opened with is not a change (it came from this device's own draft or from the PC).
    if (first.current) {
      first.current = false;
      return;
    }
    if (text === sent.current) return;
    if (text.trim() === '') {
      pending.current = null;
      sent.current = '';
      send.write('');
      return;
    }
    pending.current = text;
    const timer = window.setTimeout(() => {
      pending.current = null;
      sent.current = text;
      send.write(text);
    }, REMOTE_DRAFT_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  // The box goes away with words typed and not sent yet: they still reach the PC.
  useEffect(
    () => () => {
      const words = pending.current;
      if (words !== null && !sentWords(words)) remoteRef.current?.write(words);
    },
    [],
  );
}
