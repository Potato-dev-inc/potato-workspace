// The "Join <team>?" popup for the main window. A delivered invite link (`pm:join-link`) shows it on whatever screen the
// person is on, not only on the Team page. The Team page in Settings has its own host; only one of them answers.
import { useEffect, useState } from 'react';
import '../../styles/settings.css';
import '../../styles/join-popup-cockpit.css';
import { teamApi, type TeamApi } from '../../lib/team';
import { startJoinLinkBridge } from '../../lib/join-link-bridge';
import { JoinLinkHost } from '../settings/blocks/JoinTeamPopup';

export function CockpitJoinLink({ api = teamApi, onJoined }: { api?: TeamApi; onJoined?: () => void }) {
  const [guess, setGuess] = useState('');
  // The OS link (`potato-workspace://join/...`) arrives from the shell; this window turns it into `pm:join-link`.
  useEffect(() => startJoinLinkBridge(), []);
  useEffect(() => {
    let alive = true;
    void Promise.resolve(api.defaultName?.())
      .then((n) => alive && typeof n === 'string' && setGuess(n))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);
  // `.settings` brings the sheet's look; the wrapper is only a frame, so it takes no room and lets clicks through.
  return (
    <div className="settings jl-host" data-testid="cockpit-join-host">
      <JoinLinkHost api={api} guess={guess} onJoined={onJoined} />
    </div>
  );
}
