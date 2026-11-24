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
  NARROW_WINDOW,
  SIDE_STRIP,
  sideIsStrip,
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

describe('the dock sizes', () => {
  it('moveSplit keeps the shared height and the minimum pane height', async () => {
    const { moveSplit, DOCK_PANE_MIN } = await import('./panel-widths');
    expect(moveSplit({}, 'view', 'browser', 500, 800)).toEqual({ view: 1.25, browser: 0.75 });
    const low = moveSplit({}, 'view', 'browser', 10, 800);
    expect(low.view).toBeCloseTo((DOCK_PANE_MIN / 800) * 2, 3);
    const high = moveSplit({}, 'view', 'browser', 9000, 800);
    expect(high.browser).toBeCloseTo((DOCK_PANE_MIN / 800) * 2, 3);
    // Too little room for two panes: nothing moves.
    const same = { view: 1, browser: 1 };
    expect(moveSplit(same, 'view', 'browser', 200, 300)).toBe(same);
  });
  it('remembers the dock width and the split, and ignores damaged values', async () => {
    const m = await import('./panel-widths');
    m.setDockWidth(9999);
    m.setDockSplit({ view: 2, terminal: 1 });
    m.saveWidths();
    expect(window.localStorage.getItem(m.DOCK_WIDTH_KEY)).toBe(String(m.DOCK_MAX));
    act(() => m.resetPanelWidthsForTests());
    expect(JSON.parse(window.localStorage.getItem(m.DOCK_SPLIT_KEY)!)).toEqual({ view: 2, terminal: 1 });
    window.localStorage.setItem(m.DOCK_WIDTH_KEY, 'wide');
    window.localStorage.setItem(m.DOCK_SPLIT_KEY, '{"view":-3,"x":"a","browser":2}');
    act(() => m.resetPanelWidthsForTests());
    m.setDockWidth(m.DOCK_DEFAULT); // reads current
    m.resetDockWidth();
    expect(window.localStorage.getItem(m.DOCK_WIDTH_KEY)).toBe(String(m.DOCK_DEFAULT));
  });
});

describe('dockShown', () => {
  it('squeezes the dock so the chat keeps its floor, never below the squeeze minimum', async () => {
    const { dockShown, CHAT_FLOOR, DOCK_SQUEEZE_MIN } = await import('./panel-widths');
    expect(dockShown(460, 1280, 376, 300)).toBe(1280 - 376 - 300 - CHAT_FLOOR);
    expect(dockShown(460, 1920, 240, 300)).toBe(460);
    expect(dockShown(460, 900, 376, 300)).toBe(DOCK_SQUEEZE_MIN);
  });
});

describe('narrow window', () => {
  it('forces the strip below 800 px and leaves a wide window alone', () => {
    const wide = { width: 240, strip: false };
    expect(sideIsStrip(wide, NARROW_WINDOW - 1)).toBe(true);
    expect(sideIsStrip(wide, NARROW_WINDOW)).toBe(false);
    expect(sideIsStrip({ width: 240, strip: true }, 1400)).toBe(true);
  });
});
