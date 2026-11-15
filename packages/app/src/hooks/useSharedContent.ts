import { useCallback, useEffect, useState } from 'react';
import { takeShare, type SharedContent, type ShareCaches } from '../pwa/share-target';

/**
 * What the phone's Share menu handed to Potato. The service worker kept it in Cache Storage and opened the app on `/?share=1`;
 * this reads it once, forgets it, and takes `?share=1` off the address. Nothing here sends anything: the content only fills
 * "New chat with this", and the person presses Send.
 */
export function useSharedContent(): { shared: SharedContent | null; clear: () => void } {
  const [shared, setShared] = useState<SharedContent | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('share') !== '1') return;
    params.delete('share');
    const rest = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
    const caches = (globalThis as { caches?: ShareCaches }).caches;
    if (!caches) return;
    // No "still mounted" check: a development double-mount runs this effect twice, and the first run is the one that reads
    // (and forgets) the share. Setting state after a real unmount does nothing.
    takeShare(caches, Date.now()).then(
      (content) => content && setShared(content),
      () => undefined,
    );
  }, []);
  const clear = useCallback(() => setShared(null), []);
  return { shared, clear };
}
