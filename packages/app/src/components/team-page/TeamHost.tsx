import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { lendApi, type LendApi } from '../../lib/lend';
import { teamApi, type TeamApi, type TeamConfigView } from '../../lib/team';
import { useLend, type LendHandle } from '../lend/useLend';
import { useTeam, type TeamHandle } from '../cockpit/team/useTeam';
import { EmptyTeam } from './EmptyTeam';
import { TeamPage } from './TeamPage';
import '../../styles/cockpit-team-page.css';

/**
 * The Team page in the main area. It reads the team state and the lend state (the cockpit shares its own, so nothing
 * is read twice) and the team's settings view (people, roles, join requests). No team yet: the empty state.
 */
export function TeamHost({
  api = teamApi,
  lendClient = lendApi,
  team,
  lend,
  now,
  paneNames,
  displayName,
}: {
  api?: TeamApi;
  lendClient?: LendApi;
  team?: TeamHandle;
  lend?: LendHandle;
  now?: number;
  paneNames?: Map<string, string>;
  displayName?: string;
}) {
  const t = useT();
  const ownTeam = useTeam(api, !team);
  const ownLend = useLend(lendClient);
  const { state, refresh } = team ?? ownTeam;
  const lendHandle = lend ?? ownLend;
  const [config, setConfig] = useState<TeamConfigView | null>(null);

  const load = useCallback(() => {
    api
      .configGet()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, [api]);
  useEffect(() => {
    load();
    let off: (() => void) | undefined;
    let disposed = false;
    api
      .onChanged(load)
      .then((u) => (disposed ? u() : (off = u)))
      .catch(() => {});
    return () => {
      disposed = true;
      off?.();
    };
  }, [api, load]);

  const refreshAll = useCallback(() => {
    refresh();
    load();
  }, [refresh, load]);

  if (!config) {
    return (
      <div className="tpg tpg--loading" data-testid="team-loading">
        <p className="tpg-sub">{t('teamHub.loading')}</p>
      </div>
    );
  }
  if (config.team === '' || config.joining) {
    return (
      <div className="tpg">
        <EmptyTeam
          api={api}
          config={config}
          displayName={displayName}
          onConfig={(view) => {
            setConfig(view);
            refresh();
          }}
        />
      </div>
    );
  }
  if (!state) {
    return (
      <div className="tpg tpg--loading" data-testid="team-loading">
        <p className="tpg-sub">{t('teamHub.loading')}</p>
      </div>
    );
  }
  return <TeamPage state={state} config={config} lend={lendHandle} api={api} lendClient={lendClient} now={now ?? lendHandle.now} paneNames={paneNames} displayName={displayName} onRefresh={refreshAll} />;
}
