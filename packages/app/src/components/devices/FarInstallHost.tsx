// Mounted once in the cockpit: shows the "Install <agent> on <PC>?" sheet when `ensureInstalledOnFar` finds the agent missing there.
import { useEffect, useRef, useState } from 'react';
import { registerInstallPresenter, type InstallRequest } from '../../lib/host/ensureInstalled';
import { requestNewAgent } from '../../lib/newAgentRequest';
import { FarInstallSheet } from './FarInstallSheet';

export function FarInstallHost() {
  const [request, setRequest] = useState<InstallRequest | null>(null);
  const open = useRef<InstallRequest | null>(null);
  open.current = request;
  useEffect(() => {
    registerInstallPresenter((next) => setRequest(next));
    return () => {
      registerInstallPresenter(null);
      // The screen went away with a sheet open: that is Not now, so the caller is not left waiting.
      open.current?.finish('cancelled');
    };
  }, []);
  if (!request) return null;
  const close = (result: 'ready' | 'cancelled') => {
    setRequest(null);
    request.finish(result);
  };
  return <FarInstallSheet key={`${request.host.place.kind === 'pc' ? request.host.place.node : ''}:${request.agentId}`} request={{ ...request, finish: close }} askAgent={() => requestNewAgent()} />;
}
