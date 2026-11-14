// What the agent changed in one file, in place: the file's diff with lines you can pick (click, or Space; Shift
// extends the pick) and "Tell the agent" for the picked lines. The diff text comes from the same splitter the
// Changes view uses.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { lineKind, splitPatch } from '../cockpit/diff';
import { newLineNumbers } from '../cockpit/review-diff';
import { useT } from '../../i18n';
import { TellBar } from './TellBar';
import { tellText } from './tell-text';
import '../../styles/cockpit-changes.css';

/** The line of the new file a diff row stands for: its own number, else the next line that has one (a deleted line), else the last one. */
export function lineForRow(nums: readonly (number | null)[], i: number): number {
  for (let j = i; j < nums.length; j++) if (nums[j] !== null) return nums[j] as number;
  for (let j = i; j >= 0; j--) if (nums[j] !== null) return nums[j] as number;
  return 1;
}

export function FileDiff({
  path,
  patch,
  canTell,
  onTell,
  onOpenAt,
  onEnd,
}: {
  path: string;
  patch: string;
  canTell: boolean;
  onTell: (text: string) => void;
  /** Ctrl+Enter on a row: open the file at this line in the person's editor. Absent: the key does nothing. */
  onOpenAt?: (line: number) => void;
  /** The person has seen the whole diff: it was scrolled to the end, or it fits without scrolling. */
  onEnd?: () => void;
}) {
  const t = useT();
  const lines = useMemo(() => [...splitPatch(patch).values()][0] ?? [], [patch]);
  const nums = useMemo(() => newLineNumbers(lines), [lines]);
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  const seenEnd = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
  // A diff that fits without scrolling has been seen the moment it shows.
  useEffect(() => {
    const el = listRef.current;
    if (el && seenEnd(el)) endRef.current?.();
  }, [patch]);

  if (lines.length === 0) {
    return (
      <p className="ck-file-note" data-testid="file-diff-empty">
        {t('files.noChanges')}
      </p>
    );
  }

  const range = (a: number, b: number) => {
    const next = new Set<number>();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (lineKind(lines[i]) !== 'hunk') next.add(i);
    return next;
  };
  const choose = (i: number, extend: boolean) => {
    setCursor(i);
    // A hunk header ("@@ ...") says where, it is not a line of the file.
    if (lineKind(lines[i]) === 'hunk') return;
    if (extend && anchor !== null) return setPicked(range(anchor, i));
    setAnchor(i);
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };
  const move = (i: number, extend: boolean) => {
    const to = Math.max(0, Math.min(lines.length - 1, i));
    setCursor(to);
    if (extend) setPicked(range(anchor ?? cursor, to));
    listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[to]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLElement>, i: number) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onOpenAt) (e.preventDefault(), onOpenAt(lineForRow(nums, i)));
    else if (e.key === 'ArrowDown') (e.preventDefault(), move(i + 1, e.shiftKey));
    else if (e.key === 'ArrowUp') (e.preventDefault(), move(i - 1, e.shiftKey));
    else if (e.key === ' ' || e.key === 'Enter') (e.preventDefault(), choose(i, e.shiftKey));
    else if (e.key === 'Escape') setPicked(new Set());
  };

  const tell = (note: string) => {
    const order = [...picked].sort((a, b) => a - b);
    const body = order.map((i) => lines[i]).join('\n');
    const where = order.map((i) => nums[i]).filter((n): n is number => n !== null);
    const from = where.length ? Math.min(...where) : 1;
    const to = where.length ? Math.max(...where) : from;
    onTell(tellText(path, from, to, body, note, 'diff'));
    setPicked(new Set());
  };

  return (
    <div className="ck-file-diff">
      <div ref={listRef} className="ck-diff ck-diff-pick" role="listbox" aria-multiselectable="true" aria-label={t('files.diffLabel', { path })} data-testid="file-diff" onScroll={(e) => seenEnd(e.currentTarget) && endRef.current?.()}>
        {lines.map((line, i) => (
          <div
            key={i}
            role="option"
            aria-selected={picked.has(i)}
            aria-disabled={lineKind(line) === 'hunk' ? true : undefined}
            tabIndex={i === cursor ? 0 : -1}
            className={`ck-diff-line ck-diff-${lineKind(line)}${picked.has(i) ? ' is-picked' : ''}`}
            onClick={(e) => choose(i, e.shiftKey)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span className="ck-gutter" aria-hidden="true">
              {nums[i] ?? ''}
            </span>
            {line || ' '}
          </div>
        ))}
      </div>
      {canTell && picked.size > 0 && <TellBar count={picked.size} onTell={tell} onClear={() => setPicked(new Set())} />}
    </div>
  );
}
