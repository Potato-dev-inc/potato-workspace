// A word or a number that changes rolls: the old one goes up and fades, the new one comes up from below. The live line,
// the header status and the badge use it. Each change remounts the element, so the animation plays once per change
// (the old text is drawn by a pseudo-element from `data-prev`, so it is not in the text the screen reads).
// Under reduced motion (`.ph[data-motion='reduce']`) it is a plain 150 ms fade. Styles: styles/phone-chat.css.
import { useRef, type ReactNode } from 'react';
import '../../styles/phone-chat.css';

export function RollText({ text, children, className }: { text: string; children?: ReactNode; className?: string }) {
  const seen = useRef({ text, count: 0, prev: null as string | null });
  if (seen.current.text !== text) {
    seen.current = { text, count: seen.current.count + 1, prev: seen.current.text };
  }
  const { count, prev } = seen.current;
  return (
    <span key={count} className={className ? `ph-roll ${className}` : 'ph-roll'} data-prev={prev ?? undefined}>
      {children ?? text}
    </span>
  );
}
