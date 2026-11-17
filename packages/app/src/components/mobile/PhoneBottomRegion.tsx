// The bottom of the phone's chat: the dock (an ask, a question), the bars above the box, and the message box, as one region.
// When the agent asks, the card grows out of the message box on one height spring (SPRING.dock, no bounce) and the chat moves up
// with it (the conversation keeps itself pinned to the bottom while its size changes). When the ask is answered the card's words
// fade (140 ms), the height closes, and one quiet line stays in the chat ("You allowed: ..."). Reduced motion: the height is set
// in one frame and the words fade in 150 ms (styles/phone.css).
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { prefersReduced, SPRING, useSpring } from '../../lib/phone-motion';
import '../../styles/phone-compose.css';

/** One line the chat keeps after an ask is answered. */
export interface AnswerLine {
  id: string;
  text: string;
}

interface DockState {
  /** An ask was answered here: its line goes into the chat and the dock closes. */
  report(line: AnswerLine): void;
  /** The dock finished closing: the answered cards can leave it. */
  closed(): void;
  closing: boolean;
  /** Asks that were answered and have left the dock. */
  retired: ReadonlySet<string>;
}

export const PhoneDockContext = createContext<DockState>({ report: () => undefined, closed: () => undefined, closing: false, retired: new Set() });

/** The state a chat keeps for its dock: answered lines, the closing flag, the retired cards. Reset when the chat changes. */
export function usePhoneDockState(chatId: string): { state: DockState; lines: AnswerLine[] } {
  const [lines, setLines] = useState<AnswerLine[]>([]);
  const [closing, setClosing] = useState(false);
  const [retired, setRetired] = useState<ReadonlySet<string>>(() => new Set());
  const waiting = useRef<string[]>([]);
  useEffect(() => {
    setLines([]);
    setClosing(false);
    setRetired(new Set());
    waiting.current = [];
  }, [chatId]);
  const report = useCallback((line: AnswerLine) => {
    waiting.current.push(line.id);
    setLines((prev) => (prev.some((l) => l.id === line.id) ? prev : [...prev, line].slice(-20)));
    setClosing(true);
  }, []);
  const closed = useCallback(() => {
    const ids = waiting.current;
    waiting.current = [];
    setRetired((prev) => new Set([...prev, ...ids]));
    setClosing(false);
  }, []);
  const state = useMemo(() => ({ report, closed, closing, retired }), [report, closed, closing, retired]);
  return { state, lines };
}

/** The "You allowed: ..." lines, in the conversation. */
export function PhoneAnswerLines({ lines }: { lines: AnswerLine[] }) {
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => (
        <p key={line.id} className="ph-ask-line ph-answer-line" data-testid="phone-answer-line" role="status">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="m3.5 8.5 3 3 6-6.5" />
          </svg>
          <span>{line.text}</span>
        </p>
      ))}
    </>
  );
}

/** Words fade out for this long before the height closes. */
const FADE_OUT_MS = 140;

export function PhoneBottomRegion({ dock, above, composer }: { dock?: ReactNode; above?: ReactNode; composer?: ReactNode }) {
  const ctx = useContext(PhoneDockContext);
  const innerRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState(0);
  const measure = useCallback(() => {
    const el = innerRef.current;
    if (el) setNatural(el.offsetHeight);
  }, []);
  // Every render (a card changed its words), and whenever the content's own size changes.
  useLayoutEffect(measure);
  useEffect(() => {
    const el = innerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, dock]);

  // On "answered": the words fade first, then the height closes (at once under reduced motion).
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (!ctx.closing) {
      setGo(false);
      return;
    }
    if (prefersReduced(innerRef.current)) {
      setGo(true);
      return;
    }
    const timer = window.setTimeout(() => setGo(true), FADE_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [ctx.closing]);

  const target = ctx.closing && go ? 0 : natural;
  const height = useSpring(target, SPRING.dock);
  const { closing, closed } = ctx;
  useEffect(() => {
    if (closing && go && height === 0) closed();
  }, [closing, go, height, closed]);

  const settled = height === target;
  const style = settled && target > 0 ? undefined : { height };
  return (
    <div className="ph-region" data-region="bottom" data-testid="phone-bottom-region">
      {dock && (
        <div className="ph-region-dock" data-region="dock" data-settled={settled ? 'true' : 'false'} style={style}>
          <div ref={innerRef} className="ph-conv-dock ph-region-in" data-open={natural > 0 && !ctx.closing ? 'true' : 'false'}>
            {dock}
          </div>
        </div>
      )}
      {above}
      {composer}
    </div>
  );
}
