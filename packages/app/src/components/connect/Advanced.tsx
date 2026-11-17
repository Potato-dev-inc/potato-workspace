// "Advanced": one folded section at the bottom of a Connect tab. Closed by default. Everything technical lives here
// (nothing was removed): each term gets one plain line first, then the controls themselves.
import type { ReactNode } from 'react';
import { useT } from '../../i18n';

export type AdvancedLine = 'tunnel' | 'named' | 'custom' | 'relay' | 'token' | 'restart';

export function Advanced({ children, lines, testId }: { children: ReactNode; lines: AdvancedLine[]; testId: string }) {
  const t = useT();
  return (
    <details className="cn-adv" data-testid={testId}>
      <summary className="cn-adv-summary">{t('connect.adv.summary')}</summary>
      <div className="cn-adv-body">
        <p className="cn-adv-intro">{t('connect.adv.intro')}</p>
        <dl className="cn-adv-terms" data-testid="connect-adv-terms">
          {lines.map((l) => (
            <div key={l} className="cn-adv-term">
              <dt>{t(`connect.adv.${l}.term`)}</dt>
              <dd>{t(`connect.adv.${l}.line`)}</dd>
            </div>
          ))}
        </dl>
        {children}
      </div>
    </details>
  );
}
