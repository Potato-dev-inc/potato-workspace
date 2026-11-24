// Settings > General > About: what changed in this release, in a few plain lines. Each line jumps to the setting
// it talks about (the panel's `openRow`), so the list is also a short tour.
import { useState } from 'react';
import { useT, type MessageKey } from '../../../i18n';
import { openTour, requestGuide, whatsNewVersion } from '../../../whatsnew/store';
import type { SettingsEnv } from '../model';
import { Btn, SettingBlock } from '../settings-ui';
import { DiagnosticFile } from './DiagnosticFile';

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
  // The diagnostic line opens the review-and-save sheet right here (its Settings row is a developer row, hidden unless those are shown).
  const [diagnostic, setDiagnostic] = useState(false);
  return (
    <SettingBlock label={t('overview.whatsNew.label')} description={t('overview.whatsNew.hint')}>
      <ul className="st-labs-list">
        {ITEMS.map((item) => (
          <li key={item.to}>
            <button type="button" className="st-labs-item" onClick={() => (item.to === 'diagnostic-file' ? setDiagnostic(true) : env.openRow?.(item.to))}>
              <span className="st-labs-about">{t(item.key)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="wn-set-actions">
        <button type="button" className="st-btn" onClick={() => openTour(whatsNewVersion())}>
          {t('whatsnew.takeTour')}
        </button>
        <button type="button" className="st-btn" onClick={requestGuide}>
          {t('whatsnew.openGuide')}
        </button>
      </div>
      {diagnostic && (
        <div className="st-scrim" onMouseDown={(e) => e.target === e.currentTarget && setDiagnostic(false)} onKeyDown={(e) => e.key === 'Escape' && setDiagnostic(false)}>
          <div className="st-sheet" role="dialog" aria-modal="true" aria-label={t('settings.row.diagnostic-file.label')} data-testid="diagnostic-sheet">
            <DiagnosticFile onSaved={env.markSaved} />
            <Btn small onClick={() => setDiagnostic(false)}>
              {t('sidebar.close')}
            </Btn>
          </div>
        </div>
      )}
    </SettingBlock>
  );
}
