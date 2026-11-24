import type { TurnSummary } from '../../lib/cockpit-api';
import { formatElapsed } from './model';
import { turnSentence } from '../../lib/turn-sentence';
import { inlineCode } from './inline-code';
import { useT } from '../../i18n';

/**
 * The "Last turn" block of the Receipt tab: one plain sentence and a meta line. The sentence carries
 * this turn's own file counts, so the meta line leaves them out: two counts side by side read as a
 * contradiction. Renders nothing before the first turn (the Receipt shows its own empty state).
 */
export function LastTurn({ summary, now, reviewFiles }: { summary: TurnSummary | undefined; now: number; /** How many files the review under it lists (null: not known). It wins over "made no file changes". */ reviewFiles?: number | null }) {
  const t = useT();
  if (!summary) return null;
  const files = summary.files;
  const facts = [t('r10.last.turn', { n: summary.turn }), formatElapsed(summary.durationMs), t('r10.ago', { time: formatElapsed(now - summary.endedAtMs) })];
  return (
    <section className="ck-lastturn" aria-label={t('r10.last.title')}>
      <div className="ck-caption">{t('r10.last.title')}</div>
      <p className="ck-lastturn-line" title={files?.paths.join('\n') || undefined}>
        {inlineCode(turnSentence(t, summary.sentence, reviewFiles))}
      </p>
      <p className="ck-sub">{facts.join(' · ')}</p>
    </section>
  );
}
