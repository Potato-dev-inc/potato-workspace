// The sidebar's "Connection lost" line: shown only when a live bridge drops, never on a fresh install.
import { describe, expect, it } from 'vitest';
import { bridgeLineFor } from './useCockpit';

describe('bridgeLineFor', () => {
  it('shows nothing on a fresh install and while the bridge works', () => {
    expect(bridgeLineFor({ connectionLost: false })).toBe('');
  });

  it('says Not connected once a live bridge has dropped', () => {
    expect(bridgeLineFor({ connectionLost: true })).toBe('Not connected');
  });
});
