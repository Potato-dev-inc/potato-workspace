// Settings > General > About: what changed in this release, in a few plain lines. Each line jumps to the setting
// it talks about (the panel's `openRow`), so the list is also a short tour.
import { useT, type MessageKey } from '../../../i18n';
import type { SettingsEnv } from '../model';
import { SettingBlock } from '../settings-ui';

/** The English label (the row's id-side text); the screen shows `t('overview.whatsNew.label')`. */
export const WHATS_NEW_LABEL = "What's new"; // i18n-ok: English row label, translated by row id

const ITEMS: { key: MessageKey; to: string }[] = [
  { key: 'overview.whatsNew.budget', to: 'budget-turns' },
  { key: 'overview.whatsNew.safety', to: 'security-ask-before-control' },
  { key: 'overview.whatsNew.pack', to: 'agent-pack' },
  { key: 'overview.whatsNew.labs', to: 'labs-index' },
  { key: 'overview.whatsNew.team', to: 'team' },
  { key: 'overview.whatsNew.diagnostic', to: 'diagnostic-file' },
];

export function WhatsNew({ env }: { env: SettingsEnv }) {
  const t = useT();
  return (
    <SettingBlock label={t('overview.whatsNew.label')} description={t('overview.whatsNew.hint')}>
      <ul className="st-labs-list">
        {ITEMS.map((item) => (
          <li key={item.to}>
            <button type="button" className="st-labs-item" onClick={() => env.openRow?.(item.to)}>
              <span className="st-labs-about">{t(item.key)}</span>
            </button>
          </li>
        ))}
      </ul>
    </SettingBlock>
  );
}
