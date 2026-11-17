// The agent's last message while its turn runs: lets new words out on a 24 ms tick (lib/phone-paced-text.ts).
// `active` false (the chat is not live, or something came after this text, or the phone wants less motion) shows everything at
// once, so the text can never hold back an ask: the dock opens when the PC says so, not when this text finishes.
import { useEffect, useRef, useState } from 'react';
import { PACED_TICK_MS, pacedBehind, pacedNext, pacedSlice } from '../lib/phone-paced-text';
import { prefersReduced } from '../lib/phone-motion';

export function usePacedText(text: string, active: boolean): string {
  const on = active && !prefersReduced();
  // A message that is already on screen when it first shows is not replayed; only what arrives after is let out.
  const [shown, setShown] = useState(text.length);
  const textRef = useRef(text);
  textRef.current = text;
  const behind = on && pacedBehind(shown, text);
  useEffect(() => {
    if (!behind) return;
    const id = setInterval(() => {
      setShown((now) => {
        const next = pacedNext(now, textRef.current);
        return next === now ? now : next;
      });
    }, PACED_TICK_MS);
    return () => clearInterval(id);
  }, [behind]);
  // When pacing is off the text is whole; keep `shown` caught up so turning it on later does not replay.
  useEffect(() => {
    if (!on) setShown(text.length);
  }, [on, text.length]);
  return pacedSlice(text, shown, on);
}
