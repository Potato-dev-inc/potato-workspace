// What the box shows while the phone is listening (P15): a moving sound wave, the words as they arrive, the time, and two
// buttons. The tick keeps the words in the box (edit them, then press Send); the cross drops what this dictation added.
// Nothing is ever sent from here. The wave is still when the person asks the system for less motion.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import '../../styles/phone-compose.css';

const BARS = 5;

/** "0:04". */
export function clockWords(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function PhoneVoiceBar({ words, onKeep, onDrop }: { words: string; onKeep: () => void; onDrop: () => void }) {
  const t = useT();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="ph-voice" role="group" aria-label={t('phone.voice.aria')} data-testid="phone-voice-bar">
      <span className="ph-wave" aria-hidden="true">
        {Array.from({ length: BARS }, (_, i) => (
          <i key={i} style={{ animationDelay: `${i * 120}ms` }} />
        ))}
      </span>
      <span className="ph-voice-words" aria-live="polite">
        {words !== '' ? words : t('phone.voice.listening')}
      </span>
      <span className="ph-voice-time">{clockWords(seconds)}</span>
      <button type="button" className="ph-voice-btn" aria-label={t('phone.voice.drop')} data-testid="phone-voice-drop" onClick={onDrop}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <button type="button" className="ph-voice-btn ph-voice-keep" aria-label={t('phone.voice.keep')} data-testid="phone-voice-keep" onClick={onKeep}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </button>
    </div>
  );
}
