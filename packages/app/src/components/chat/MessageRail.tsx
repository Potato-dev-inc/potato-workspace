// The message rail: a thin stack of grey dashes beside the chat's scroll bar, one per message (the person's and the
// agent's replies), evenly spaced. The one being read is brighter and longer. Hover shows who wrote it and its first
// lines; a click jumps to it and a drag along the dashes scrubs through the chat. Find matches brighten their dashes.
// Alt+Up / Alt+Down jump between the person's own messages. Positions come from the message count and the rail's
// height alone (messageRailModel); the message being read is read from where the messages are, on each scroll (one read per frame).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { useT } from '../../i18n';
import { useMessageRail } from '../../lib/messageRail';
import '../../styles/cockpit-chat-mrail.css';
import { neighbourOwn, railMatches, railSlots, RAIL_MIN_MESSAGES, slotAt, slotOfEntry, type RailEntry } from './messageRailModel';

/** How long the message a jump landed on keeps its soft wash. */
const FLASH_MS = 1200;
/** The card shows at most this much of a message (the page clips it to three lines). */
const CARD_CHARS = 280;
/** The height assumed before the rail has been measured (and in a test with no layout). */
const FALLBACK_HEIGHT = 240;
/** The reading line, in pixels from the top of the chat's box: a message whose top is above it is the one being read. */
const READING_LINE = 24;

const escapeAttr = (value: string): string => value.replace(/["\\]/g, '\\$&');

interface Hover {
  slot: number;
  y: number;
  touch: boolean;
}

export interface MessageRailProps {
  entries: readonly RailEntry[];
  /** The chat's scrolling box: the messages are inside it. */
  scrollRef: RefObject<HTMLElement | null>;
  /** The chat's outer box: Alt+Up / Alt+Down work while the keyboard is anywhere in it. */
  rootRef: RefObject<HTMLElement | null>;
  /** What Find in this chat looks for ('' when the box is closed). */
  findQuery: string;
}

export function MessageRail({ entries, scrollRef, rootRef, findQuery }: MessageRailProps) {
  const t = useT();
  const [enabled] = useMessageRail();
  const show = enabled && entries.length >= RAIL_MIN_MESSAGES;
  const railRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(FALLBACK_HEIGHT);
  const [visibleIndex, setVisibleIndex] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  // A dash the person clicked (or dragged over) wins until they scroll themselves: a jump near the end of the chat
  // must not hand the mark to the last dash. The ref is read by the scroll handlers, which run outside React.
  const [pin, setPin] = useState<number | null>(null);
  const pinRef = useRef<number | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const dragging = useRef(false);
  const lastSlot = useRef(-1);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flashed = useRef<Element | null>(null);

  const slots = useMemo(() => railSlots(entries.length, height), [entries.length, height]);
  const matches = useMemo(() => railMatches(entries, findQuery), [entries, findQuery]);
  const current = pin !== null ? Math.min(pin, entries.length - 1) : atEnd ? entries.length - 1 : Math.min(visibleIndex, entries.length - 1);
  const currentSlot = slotOfEntry(slots, current);

  // The newest values, for the key handler and the observer (they must not be rebuilt for every streamed word).
  const latest = useRef({ entries, current });
  latest.current = { entries, current };
  const idsKey = useMemo(() => entries.map((entry) => entry.id).join('|'), [entries]);

  // The rail's height (a resize observer, not a read per frame).
  useEffect(() => {
    const el = railRef.current;
    if (!show || !el) return;
    const measure = () => setHeight(el.clientHeight || FALLBACK_HEIGHT);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [show]);

  // The message being read: the one at the top of the chat's box, read from where the messages really are, so the mark
  // follows the scroll (wheel, scroll bar, keys) and a jump alike. A message whose top is at or above the reading line
  // counts, and the lowest of those is the one being read; with none above the line, the first message is. At the very
  // end the last message is the one being read, even when it is too short to reach the line.
  const readPosition = useCallback(() => {
    const box = scrollRef.current;
    // A box with no layout (the chat is hidden) has nothing to read yet.
    if (!box || box.clientHeight === 0) return;
    // While a clicked dash is pinned, the chat's own scroll (the jump) does not move the mark.
    if (pinRef.current !== null) return;
    setAtEnd(box.scrollHeight - box.scrollTop - box.clientHeight <= 24);
    const origin = box.getBoundingClientRect().top;
    const indexOf = new Map(latest.current.entries.map((entry, i) => [entry.id, i]));
    let best = -1;
    let bestOffset = -Infinity;
    let first = -1;
    box.querySelectorAll<HTMLElement>('[data-rail-id]').forEach((node) => {
      const i = indexOf.get(node.dataset.railId ?? '');
      if (i === undefined) return;
      if (first < 0) first = i;
      const offset = node.getBoundingClientRect().top - origin;
      if (offset <= READING_LINE && offset > bestOffset) {
        bestOffset = offset;
        best = i;
      }
    });
    const reading = best >= 0 ? best : first;
    if (reading >= 0) setVisibleIndex(reading);
  }, [scrollRef]);

  // The reading position follows the scroll. A scroll event comes once per frame, so this reads no more than that.
  useEffect(() => {
    const box = scrollRef.current;
    if (!show || !box) return;
    const onScroll = () => readPosition();
    // The person's own scrolling (wheel, touch, keys, a press on the scroll bar) ends the pin: the mark follows the
    // position again. Scrolls the rail makes itself do not reach these listeners as user input.
    const unpin = () => {
      if (pinRef.current === null) return;
      pinRef.current = null;
      setPin(null);
      readPosition();
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    box.addEventListener('wheel', unpin, { passive: true });
    box.addEventListener('touchstart', unpin, { passive: true });
    box.addEventListener('pointerdown', unpin);
    box.addEventListener('keydown', unpin);
    return () => {
      box.removeEventListener('scroll', onScroll);
      box.removeEventListener('wheel', unpin);
      box.removeEventListener('touchstart', unpin);
      box.removeEventListener('pointerdown', unpin);
      box.removeEventListener('keydown', unpin);
    };
  }, [show, scrollRef, readPosition]);

  // A message that arrives or changes moves the reading position too (a reply while the chat sits at its end).
  useEffect(() => {
    if (show) readPosition();
  }, [show, idsKey, readPosition]);

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const jumpTo = useCallback(
    (index: number) => {
      const entry = latest.current.entries[index];
      const box = scrollRef.current;
      if (!entry || !box) return;
      const el = box.querySelector<HTMLElement>(`[data-rail-id="${escapeAttr(entry.id)}"]`);
      if (!el) return;
      // The mark shows the message that was clicked, and keeps showing it while the jump settles (even at the end).
      pinRef.current = index;
      setPin(index);
      el.scrollIntoView({ block: 'start' });
      // A turn the browser has not laid out yet (content-visibility) has a guessed height: settle on the next frame.
      requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
      flashed.current?.classList.remove('ck-mrail-flash');
      el.classList.add('ck-mrail-flash');
      flashed.current = el;
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => el.classList.remove('ck-mrail-flash'), FLASH_MS);
    },
    [scrollRef],
  );

  const stepOwn = useCallback(
    (direction: -1 | 1) => {
      const to = neighbourOwn(latest.current.entries, latest.current.current, direction);
      if (to !== null) jumpTo(to);
    },
    [jumpTo],
  );

  // Alt+Up / Alt+Down anywhere in the chat.
  useEffect(() => {
    const root = rootRef.current;
    if (!show || !root) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      stepOwn(event.key === 'ArrowUp' ? -1 : 1);
    };
    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }, [show, rootRef, stepOwn]);

  if (!show) return null;

  const yOf = (event: PointerEvent) => event.clientY - (railRef.current?.getBoundingClientRect().top ?? 0);
  const aim = (event: PointerEvent) => {
    const slot = slotAt(slots, yOf(event));
    setHover({ slot, y: yOf(event), touch: event.pointerType === 'touch' });
    if (dragging.current && slot !== lastSlot.current) {
      lastSlot.current = slot;
      jumpTo(slots[slot].index);
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button > 0) return;
    dragging.current = true;
    try {
      railRef.current?.setPointerCapture?.(event.pointerId);
    } catch {
      // The pointer is already gone: the click below still works.
    }
    lastSlot.current = -1;
    aim(event);
  };
  const onPointerEnd = () => {
    dragging.current = false;
    lastSlot.current = -1;
    setHover(null);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    stepOwn(event.key === 'ArrowUp' ? -1 : 1);
  };

  const hovered = hover ? entries[slots[hover.slot]?.index ?? 0] : null;
  const cardTop = hover ? Math.min(Math.max(hover.y, 36), Math.max(36, height - 36)) : 0;

  return (
    <div
      ref={railRef}
      className="ck-mrail"
      role="group"
      tabIndex={0}
      aria-label={t('chatUx.rail.label')}
      data-testid="message-rail"
      onPointerDown={onPointerDown}
      onPointerMove={aim}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onPointerLeave={() => !dragging.current && setHover(null)}
      onKeyDown={onKeyDown}
    >
      {slots.map((slot, i) => {
        let hit = false;
        if (matches.size > 0) for (let k = slot.from; k <= slot.to && !hit; k++) hit = matches.has(k);
        const cls = `ck-mrail-dash${i === currentSlot ? ' is-current' : ''}${hit ? ' is-hit' : ''}${hover?.slot === i ? ' is-hover' : ''}`;
        return <i key={i} className={cls} style={{ top: slot.top - 1 }} data-testid="message-rail-dash" data-entry={slot.index} />;
      })}
      {hovered && hover && (
        <div className={`ck-mrail-card${hover.touch ? ' is-touch' : ''}`} style={{ top: cardTop }} role="tooltip" data-testid="message-rail-card">
          <div className="ck-mrail-card-who">{hovered.who === 'you' ? t('chatUx.rail.you') : t('chatUx.rail.agent')}</div>
          <div className="ck-mrail-card-text">{hovered.text.trim().slice(0, CARD_CHARS) || t('chatUx.rail.noText')}</div>
        </div>
      )}
    </div>
  );
}
