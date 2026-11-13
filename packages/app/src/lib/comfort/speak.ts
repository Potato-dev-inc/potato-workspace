// Say results out loud (off by default): when an agent finishes, the built-in Windows voice says one line.
// Nothing leaves the computer: speechSynthesis is the system voice. Only new finishes are spoken; the ones
// already there when the switch turns on (or when the app opens) are remembered and stay silent.
import { useEffect, useRef } from 'react';
import type { AttentionItem, AttentionSnapshot } from '../attention';
import { t } from '../../i18n';
import { getComfort } from './store';

/** The line for a finished agent, or null for any other item. */
export function finishedLine(item: AttentionItem): string | null {
  if (item.kind !== 'done') return null;
  const agent = item.pane?.agent || item.pane?.heading || item.title;
  return t('lookFeel.comfort.speak.finished', { agent });
}

/** Speak a line with the system voice. Returns false where speech is not available. */
export function speakLine(text: string, lang: string): boolean {
  if (typeof window === 'undefined' || !window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') return false;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  window.speechSynthesis.speak(utterance);
  return true;
}

/** Watch the attention snapshot and speak each agent that finishes, when the switch is on. */
export function useSpeakFinished(snapshot: AttentionSnapshot | null, lang = 'en-US'): void {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    const done = snapshot.items.filter((item) => item.kind === 'done' && item.state === 'open');
    if (seen.current === null) {
      seen.current = new Set(done.map((item) => item.id));
      return;
    }
    const known = seen.current;
    const fresh = done.filter((item) => !known.has(item.id));
    for (const item of done) known.add(item.id);
    if (!getComfort().speakResults) return;
    for (const item of fresh) {
      const line = finishedLine(item);
      if (line) speakLine(line, lang);
    }
  }, [snapshot, lang]);
}
