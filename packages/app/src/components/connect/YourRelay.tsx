// "Your relay": the one Worker address every Connect tab uses, with how it is doing and which tabs use it. Read only:
// it never shows a secret. Setting it up is done where the person already is (Phone: keep one address; Team: Start a team).
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { oneRelay, relayUsers } from '../../lib/relay';
import type { TeamApi } from '../../lib/team';
import type { TunnelStatus } from '../../lib/tauri-types';
import type { TunnelApi } from '../settings/TunnelSection';

export function YourRelay({ tunnel, team }: { tunnel: TunnelApi; team: Pick<TeamApi, 'configGet'> }) {
  const t = useT();
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [teamRelay, setTeamRelay] = useState('');
  const linked = useRef(false);
  linked.current = oneRelay(status)?.link === 'linked';
  useEffect(() => {
    let alive = true;
    const load = () => {
      void Promise.resolve()
        .then(() => tunnel.getStatus())
        .then((s) => alive && setStatus(s))
        .catch(() => undefined);
      void Promise.resolve()
        .then(() => team.configGet())
        .then((c) => alive && setTeamRelay(c.relay ?? ''))
        .catch(() => undefined);
    };
    load();
    // The phone link settles by itself ("Not linked yet" -> "Ready"), so read it again while it is not up.
    const id = window.setInterval(() => alive && !linked.current && load(), 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [tunnel, team]);

  const relay = oneRelay(status);
  const users = relayUsers(relay, teamRelay);
  return (
    <p className="cn-relay" data-testid="connect-relay" data-state={relay ? relay.link : 'none'}>
      <span className="cn-relay-label">{t('connect.relay.label')}</span>
      {relay ? (
        <>
          <strong className="font-mono break-all" data-testid="connect-relay-host">
            {relay.host}
          </strong>
          <span className="cn-relay-status" data-testid="connect-relay-status">
            {t(`connect.relay.status.${relay.link}`)}
          </span>
          <span className="cn-relay-used" data-testid="connect-relay-used">
            {t('connect.relay.used', { users: users.map((u) => t(`connect.relay.user.${u}`)).join(t('connect.relay.sep')) })}
          </span>
        </>
      ) : (
        <span data-testid="connect-relay-none">{t('connect.relay.none')}</span>
      )}
    </p>
  );
}
