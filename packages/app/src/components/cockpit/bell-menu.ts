// The bell choices for one agent, as rows of the pane's ⋯ menu. The row for the level in use says so.
import type { MessageKey, PluralKey } from '../../i18n/en';
import { BELL_LEVELS, type BellLevel } from '../../lib/notify-levels';
import type { MoreAction } from './PaneMoreMenu';

type Translate = (key: MessageKey | PluralKey, vars?: Record<string, string | number>) => string;

const LEVEL_KEY: Record<BellLevel, MessageKey> = {
  everything: 'notify.level.everything',
  needs: 'notify.level.needs',
  finished: 'notify.level.finished',
  silent: 'notify.level.silent',
};

/** One menu row per bell level, in order. The one in use reads "(now)". */
export function bellMenuActions(level: BellLevel, setLevel: (next: BellLevel) => void, t: Translate): MoreAction[] {
  return BELL_LEVELS.map((option) => {
    const name = t(LEVEL_KEY[option]);
    const current = option === level;
    return {
      id: `bell-${option}`,
      label: t(current ? 'notify.bell.optionNow' : 'notify.bell.option', { level: name }),
      title: t('notify.bell.tip'),
      onSelect: () => setLevel(option),
    };
  });
}
