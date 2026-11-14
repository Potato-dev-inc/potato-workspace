// Fold long code and long output: a block over FOLD_LINES lines shows its first FOLD_LINES lines and a
// "Show all N lines" button. The fold cuts the text itself (not a CSS clip), so a folded block also costs less to draw.
// Copy buttons still copy everything (they get the full text), and Find in this chat opens a fold that holds a match.
import { useState } from 'react';
import { useT } from '../../i18n';
import { holdsQuery, useFindQuery } from './chatFind';

/** A block of more lines than this folds. */
export const FOLD_LINES = 30;

export interface Fold {
  /** The text to draw: all of it, or the first FOLD_LINES lines while folded. */
  shown: string;
  /** The block is over the limit (so it has a button), folded or not. */
  long: boolean;
  folded: boolean;
  lines: number;
  toggle: () => void;
}

/** How many lines `text` has (a trailing newline does not add one). */
export function countLines(text: string): number {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** The first `limit` lines of `text`, as written. */
export function firstLines(text: string, limit: number): string {
  let at = -1;
  for (let i = 0; i < limit; i++) {
    at = text.indexOf('\n', at + 1);
    if (at < 0) return text;
  }
  return text.slice(0, at);
}

export function useFold(text: string, limit: number = FOLD_LINES): Fold {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const query = useFindQuery();
  const lines = countLines(text);
  const long = lines > limit;
  // Find in this chat: a fold that holds the match opens by itself (a click still wins).
  const open = toggled ?? (long && holdsQuery(text, query));
  const folded = long && !open;
  return { shown: folded ? firstLines(text, limit) : text, long, folded, lines, toggle: () => setToggled(!open) };
}

/** The button under a long block: "Show all N lines", then "Show less". Nothing for a short block. */
export function FoldButton({ fold, className }: { fold: Fold; className: string }) {
  const t = useT();
  if (!fold.long) return null;
  return (
    <button type="button" className={className} aria-expanded={!fold.folded} data-testid="fold-toggle" onClick={fold.toggle}>
      {fold.folded ? t('chatUx.fold.show', { n: fold.lines }) : t('chatUx.fold.hide')}
    </button>
  );
}
