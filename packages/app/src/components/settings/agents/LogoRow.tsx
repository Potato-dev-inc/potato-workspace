// "Logo" row on an agent's page: pick a picture from this computer to use as the agent's mark. Kept on this computer
// only. "Use the original" goes back to the built-in mark.
import { useRef, useState } from 'react';
import { useT } from '../../../i18n';
import { readLogoFile, setCustomLogo, useCustomLogo } from '../../../lib/customAgentLogos';
import { Btn, Note, SettingRow } from '../settings-ui';
import type { AgentRow } from './useAgentRows';

export function LogoRow({ row }: { row: AgentRow }) {
  const t = useT();
  const custom = useCustomLogo(row.id);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const result = await readLogoFile(file);
    if (result.ok) setCustomLogo(row.id, result.dataUrl);
    else setError(t(result.why === 'size' ? 'agentPage.logoTooBig' : 'agentPage.logoBadFile'));
  };
  return (
    <>
      <SettingRow label={t('agentPage.logo')} description={t('agentPage.logoHelp')}>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
          hidden
          data-testid="agent-logo-file"
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <Btn small aria-label={t('agentPage.logoChooseAria', { label: row.label })} onClick={() => input.current?.click()}>
          {t('agentPage.logoChoose')}
        </Btn>
        {custom && (
          <Btn small aria-label={t('agentPage.logoResetAria', { label: row.label })} onClick={() => setCustomLogo(row.id, null)}>
            {t('agentPage.logoReset')}
          </Btn>
        )}
      </SettingRow>
      {error && <Note role="alert">{error}</Note>}
    </>
  );
}
