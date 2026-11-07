// Spaces (Labs `spaces_enabled`, off by default): small-group chat between people's own computers.
// Nothing user-visible may appear while the flag is off; screens call `useSpacesEnabled()` and render nothing.
import { useEffect, useState } from 'react';
import { loadSettings } from './settings';

export const SPACES_LABS_KEY = 'spaces_enabled' as const;

export function spacesEnabled(settings: { spaces_enabled?: boolean } | null | undefined): boolean {
  return settings?.spaces_enabled === true;
}

export function useSpacesEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void loadSettings().then(
      (settings) => {
        if (live) setOn(spacesEnabled(settings));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return on;
}
