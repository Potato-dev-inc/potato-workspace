// @vitest-environment jsdom
// Which right-panel sections are folded. Two windows of the app keep their own copy of the list; a fold in one must not be
// undone by a fold in the other, and a change made in another window must show up here.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RAIL_CLOSED_KEY, resetRailFoldForTests, isRailSectionClosed, setRailSectionClosed } from './railFold';

beforeEach(() => {
  window.localStorage.clear();
  resetRailFoldForTests();
});
afterEach(() => {
  window.localStorage.clear();
  resetRailFoldForTests();
});

describe('rail fold list', () => {
  it('folds and opens one section, and the list is kept in storage', () => {
    setRailSectionClosed('bg', true);
    expect(isRailSectionClosed('bg')).toBe(true);
    expect(window.localStorage.getItem(RAIL_CLOSED_KEY)).toBe('bg');
    setRailSectionClosed('bg', false);
    expect(isRailSectionClosed('bg')).toBe(false);
  });

  it('a fold in this window does not re-fold a section another window opened', () => {
    // This window folds Background tasks; then the other window opens it (storage changes, this window is not told).
    setRailSectionClosed('bg', true);
    window.localStorage.setItem(RAIL_CLOSED_KEY, '');
    // Folding Files here must write the stored list, not this window's stale copy that still has "bg".
    setRailSectionClosed('files', true);
    expect(window.localStorage.getItem(RAIL_CLOSED_KEY)).toBe('files');
    expect(isRailSectionClosed('bg')).toBe(false);
  });

  it('takes the list of another window when its storage changes', () => {
    setRailSectionClosed('bg', true);
    expect(isRailSectionClosed('bg')).toBe(true);
    window.localStorage.setItem(RAIL_CLOSED_KEY, 'ctx');
    window.dispatchEvent(new StorageEvent('storage', { key: RAIL_CLOSED_KEY, newValue: 'ctx' }));
    expect(isRailSectionClosed('bg')).toBe(false);
    expect(isRailSectionClosed('ctx')).toBe(true);
  });

  it('ignores storage changes for other keys', () => {
    setRailSectionClosed('bg', true);
    window.localStorage.setItem(RAIL_CLOSED_KEY, '');
    window.dispatchEvent(new StorageEvent('storage', { key: 'pm.other', newValue: 'x' }));
    expect(isRailSectionClosed('bg')).toBe(true);
  });
});
