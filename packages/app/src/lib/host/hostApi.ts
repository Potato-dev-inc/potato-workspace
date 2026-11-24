// The project-folder, artifact, review and usage apis of ONE place. This PC keeps the api it always had (`local`); another PC gets the same api made
// over its host (`make`). A component calls `useHostApi(localApi, makeFor)` and never asks where it is.
import { useMemo } from 'react';
import type { Host } from './host';
import { useHost } from './context';

export const forHost = <T,>(host: Host, local: T, make: (host: Host) => T): T => (host.place.kind === 'local' ? local : make(host));

export function useHostApi<T>(local: T, make: (host: Host) => T): T {
  const host = useHost();
  return useMemo(() => forHost(host, local, make), [host, local, make]);
}
