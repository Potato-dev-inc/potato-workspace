import { useT } from '../../i18n';
import type { LendApi } from '../../lib/lend';
import type { TeamApi } from '../../lib/team';
import { TeamPage as TeamSettings } from '../settings/blocks/TeamPage';

/**
 * Setup: the people table with roles, invite code, connection and Leave team. This is the Settings team block, re-hosted
 * as it is (same words, same calls), so nothing about team setup changes.
 */
export function SetupTab({ api, lendApi, displayName }: { api: TeamApi; lendApi?: LendApi; displayName?: string }) {
  const t = useT();
  return (
    <div className="tpg-setup" data-testid="setup-tab">
      <p className="tpg-sub">{t('teamHub.setup.note')}</p>
      <TeamSettings api={api} lend={lendApi} displayName={displayName} />
    </div>
  );
}
