// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHAT_MIN,
  RAIL_DEFAULT,
  RAIL_MAX,
  RAIL_MIN,
  RAIL_WIDTH_KEY,
  SIDE_DEFAULT,
  SIDE_KEY,
  SIDE_MAX,
  SIDE_MIN,
  SIDE_STRIP,
  railFits,
  railFromPx,
  railShown,
  resetPanelWidthsForTests,
  resetRailWidth,
  resetSideWidth,
  saveWidths,
  setRailWidth,
  setSideWidth,
  sideFromPx,
  sidePx,
  usePanelWidths,
} from './panel-widths';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('sidebar width rules', () => {
  it('stays between 180 and 420 px', () => {
    expect(sideFromPx(300)).toEqual({ width: 300, strip: false });
    expect(sideFromPx(150)).toEqual({ width: SIDE_MIN, strip: false });
    expect(sideFromPx(9999)).toEqual({ width: SIDE_MAX, strip: false });
  });
  it('snaps to the icon strip below 140 px', () => {
    expect(sideFromPx(139).strip).toBe(true);
    expect(sideFromPx(140).strip).toBe(false);
    expect(sidePx(sideFromPx(100))).toBe(SIDE_STRIP);
  });
  it('a width that is not a number is the normal width', () => {
    expect(sideFromPx(NaN)).toEqual({ width: SIDE_DEFAULT, strip: false });
  });
});

describe('right panel width rules', () => {
  it('stays between 240 and 520 px', () => {
    expect(railFromPx(100)).toBe(RAIL_MIN);
    expect(railFromPx(700)).toBe(RAIL_MAX);
    expect(railFromPx(333.4)).toBe(333);
  });
  it('hides only when the chat would get under 480 px beside the narrowest panel', () => {
    expect(railFits(RAIL_MIN + CHAT_MIN + SIDE_DEFAULT, SIDE_DEFAULT)).toBe(true);
    expect(railFits(RAIL_MIN + CHAT_MIN + SIDE_DEFAULT - 1, SIDE_DEFAULT)).toBe(false);
    // A thin strip frees room for it.
    expect(railFits(800, SIDE_STRIP)).toBe(true);
  });
  it('is held back so the chat keeps 480 px, never below the minimum', () => {
    expect(railShown(520, 1400, 240)).toBe(520);
    expect(railShown(520, 1100, 240)).toBe(380);
    expect(railShown(520, 900, 240)).toBe(RAIL_MIN);
  });
});

describe('remembered widths', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetPanelWidthsForTests();
  });
  const read = () => {
    let latest!: ReturnType<typeof usePanelWidths>;
    const host = document.createElement('div');
    const root = createRoot(host);
    function Probe() {
      latest = usePanelWidths();
      return null;
    }
    act(() => root.render(<Probe />));
    return { get: () => latest, stop: () => act(() => root.unmount()) };
  };

  it('starts at the normal widths', () => {
    const r = read();
    expect(r.get().side).toEqual({ width: SIDE_DEFAULT, strip: false });
    expect(r.get().rail).toBe(RAIL_DEFAULT);
    r.stop();
  });
  it('saves on commit, not on every move, and reads it back', () => {
    const r = read();
    act(() => setSideWidth(300));
    act(() => setRailWidth(400));
    expect(r.get().side.width).toBe(300);
    expect(window.localStorage.getItem(SIDE_KEY)).toBeNull();
    saveWidths();
    expect(window.localStorage.getItem(SIDE_KEY)).toBe('300');
    expect(window.localStorage.getItem(RAIL_WIDTH_KEY)).toBe('400');
    act(() => resetPanelWidthsForTests());
    expect(r.get().side.width).toBe(300);
    expect(r.get().rail).toBe(400);
    r.stop();
  });
  it('remembers the strip', () => {
    const r = read();
    act(() => setSideWidth(300));
    act(() => setSideWidth(90));
    expect(r.get().side).toEqual({ width: 300, strip: true });
    saveWidths();
    expect(window.localStorage.getItem(SIDE_KEY)).toBe('strip');
    act(() => resetPanelWidthsForTests());
    expect(r.get().side.strip).toBe(true);
    r.stop();
  });
  it('ignores a damaged stored value', () => {
    window.localStorage.setItem(SIDE_KEY, 'wide');
    window.localStorage.setItem(RAIL_WIDTH_KEY, '9999');
    act(() => resetPanelWidthsForTests());
    const r = read();
    expect(r.get().side).toEqual({ width: SIDE_DEFAULT, strip: false });
    expect(r.get().rail).toBe(RAIL_MAX);
    r.stop();
  });
  it('reset goes back to the normal widths and saves them', () => {
    setSideWidth(380);
    setRailWidth(500);
    resetSideWidth();
    resetRailWidth();
    expect(window.localStorage.getItem(SIDE_KEY)).toBe(String(SIDE_DEFAULT));
    expect(window.localStorage.getItem(RAIL_WIDTH_KEY)).toBe(String(RAIL_DEFAULT));
  });
});
