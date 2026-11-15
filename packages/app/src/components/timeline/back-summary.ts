// "12 would change, 3 would come back, 2 would be removed": what going back to a point would do, in words.
import type { MessageKey } from '../../i18n';
import type { NowDiff } from '../../lib/timeline';

type Say = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function backSummary(back: Pick<NowDiff, 'changed' | 'restored' | 'removed'>, t: Say): string {
  const parts: string[] = [];
  if (back.changed > 0) parts.push(t('timeline.sum.changed', { n: back.changed }));
  if (back.restored > 0) parts.push(t('timeline.sum.restored', { n: back.restored }));
  if (back.removed > 0) parts.push(t('timeline.sum.removed', { n: back.removed }));
  return parts.length > 0 ? parts.join(', ') : t('timeline.sum.nothing');
}
