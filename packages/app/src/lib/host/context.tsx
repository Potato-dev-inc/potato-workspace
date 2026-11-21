import { createContext, useContext, type ReactNode } from 'react';
import type { Host } from './host';
import { localHost } from './local';

const HostContext = createContext<Host>(localHost);

/** The host of the place this subtree shows. Without a provider: this PC. */
export const useHost = (): Host => useContext(HostContext);

export function HostProvider({ host, children }: { host: Host; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}
