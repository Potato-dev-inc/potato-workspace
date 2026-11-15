// "Ready" in the phone drawer: the standby helpers that are started and waiting (`GET /phone/helpers`, needs `watch`).
// Read-only. Nothing shows when there is none, or when the PC does not have the route. Folder name only, never a path.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import type { BridgeClient, PhoneHelper } from '../../lib/bridge-types';
import { PhoneAgentTile } from './PhoneAgentTile';

export function PhoneReadyHelpers({ bridge, open }: { bridge: Pick<BridgeClient, 'phoneHelpers'>; open: boolean }) {
  const t = useT();
  const [helpers, setHelpers] = useState<PhoneHelper[]>([]);
  useEffect(() => {
    if (!open || !bridge.phoneHelpers) return;
    let live = true;
    void bridge
      .phoneHelpers()
      .then((reply) => {
        if (live) setHelpers(reply.helpers.filter((h) => h.state === 'ready'));
      })
      .catch(() => {
        // Optional: an old PC or a blip shows nothing.
      });
    return () => {
      live = false;
    };
  }, [bridge, open]);
  if (helpers.length === 0) return null;
  return (
    <section aria-label={t('standby.state.ready')} data-testid="drawer-ready">
      <h2 className="ph-dsec">{t('standby.state.ready')}</h2>
      <ul className="ph-dlist">
        {helpers.map((h) => (
          <li key={h.id}>
            <div className="ph-drow ph-drow--static" data-ready-helper={h.id}>
              <PhoneAgentTile id={h.agent} name={h.agent} dot="working" />
              <span className="ph-drow-text">
                <span className="ph-drow-title">{h.name}</span>
                <span className="ph-drow-state">{[h.folder, t('standby.state.ready')].filter(Boolean).join(' · ')}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
