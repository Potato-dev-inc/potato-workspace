import { describe, expect, it } from 'vitest';
import {
  DOMINO_MS,
  FADE_MS,
  INK_MS,
  MAX_ANIMATED,
  SEED_PX,
  dominoTilt,
  faceFade,
  keyframes,
  motionFor,
  onMonitor,
  orderPanes,
  parseSwitchStyle,
  pickSource,
  seed,
  splitAnimated,
  staggerMs,
  timing,
  toLocal,
  totalMs,
  type Rect,
} from './model';
import { previewSpec } from './preview';

const A = { left: 100, top: 100, width: 400, height: 300 };
const B = { left: 700, top: 300, width: 200, height: 100 };

describe('Domino timing', () => {
  it('staggers 80 ms apart and caps at 240 ms', () => {
    expect([0, 1, 2, 3, 4, 7].map((i) => staggerMs(i, 8, false))).toEqual([0, 80, 160, 240, 240, 240]);
  });

  it('plays the other way round on the way back, with the same cap', () => {
    expect([0, 1, 2, 3, 4, 7].map((i) => staggerMs(i, 8, true))).toEqual([240, 240, 240, 240, 240, 0]);
    expect(staggerMs(0, 3, true)).toBe(160);
    expect(staggerMs(2, 3, true)).toBe(0);
  });

  it('runs 530 ms, ease-in-out', () => {
    expect(timing('domino', 2, 5, false)).toEqual({ duration: DOMINO_MS, delay: 160, easing: 'ease-in-out' });
    expect(DOMINO_MS).toBe(530);
  });

  it('tilts the active pane -2deg and every other pane 8deg at the halfway frame', () => {
    expect(dominoTilt(0)).toBe(-2);
    expect(dominoTilt(1)).toBe(8);
    const frames = (i: number) => keyframes('domino', A, B, i);
    expect(frames(0)[1].transform).toBe('rotate(-2deg)');
    expect(frames(3)[1].transform).toBe('rotate(8deg)');
  });

  it('goes start -> halfway geometry -> end with no rotation at either end', () => {
    const [from, halfway, to] = keyframes('domino', A, B, 1);
    expect(from).toMatchObject({ left: '100px', top: '100px', width: '400px', height: '300px', transform: 'rotate(0deg)', offset: 0 });
    expect(halfway).toMatchObject({ left: '400px', top: '200px', width: '300px', height: '200px', offset: 0.5 });
    expect(to).toMatchObject({ left: '700px', top: '300px', width: '200px', height: '100px', transform: 'rotate(0deg)', offset: 1 });
  });

  it('animates left/top/width/height, never scale, so text does not stretch', () => {
    for (const motion of ['domino', 'ink', 'fade'] as const) {
      for (const frame of keyframes(motion, A, B, 1)) {
        expect(JSON.stringify(frame)).not.toMatch(/scale/i);
        expect(frame).toHaveProperty('width');
      }
    }
  });

  it('lasts until the last stagger plus 530 ms', () => {
    expect(totalMs('domino', 1)).toBe(530);
    expect(totalMs('domino', 5)).toBe(240 + 530);
    expect(totalMs('domino', 8)).toBe(240 + 530);
    expect(totalMs('domino', 0)).toBe(0);
  });
});

describe('Ink', () => {
  it('runs 720 ms with no stagger', () => {
    expect(timing('ink', 0, 5, false)).toEqual({ duration: INK_MS, delay: 0, easing: 'ease-in-out' });
    expect(timing('ink', 4, 5, true).delay).toBe(0);
    expect(totalMs('ink', 6)).toBe(720);
  });

  it('shrinks to a 30 px seed centred on the source (.27), flies, then a seed on the destination (.68)', () => {
    const [from, s1, s2, to] = keyframes('ink', A, B, 0);
    expect(SEED_PX).toBe(30);
    expect(from).toMatchObject({ left: '100px', width: '400px', borderRadius: '7px', offset: 0 });
    // centre of A is (300, 250): a 30 px square there
    expect(s1).toMatchObject({ left: '285px', top: '235px', width: '30px', height: '30px', borderRadius: '50%', offset: 0.27 });
    // centre of B is (800, 350)
    expect(s2).toMatchObject({ left: '785px', top: '335px', width: '30px', height: '30px', borderRadius: '50%', offset: 0.68 });
    expect(to).toMatchObject({ left: '700px', width: '200px', borderRadius: '7px', offset: 1 });
  });

  it('seed() centres a square on a box', () => {
    expect(seed({ left: 0, top: 0, width: 100, height: 50 }, 30)).toEqual({ left: 35, top: 10, width: 30, height: 30 });
  });
});

describe('reduced motion and Off', () => {
  it('a reduced-motion setting plays a 120 ms fade whatever style was chosen', () => {
    for (const style of ['domino', 'ink', 'off'] as const) expect(motionFor(style, true)).toBe('fade');
  });

  it('Off is the same quick fade; Domino and Ink play as chosen', () => {
    expect(motionFor('off', false)).toBe('fade');
    expect(motionFor('domino', false)).toBe('domino');
    expect(motionFor('ink', false)).toBe('ink');
  });

  it('the fade is 120 ms, has no stagger and nothing moves', () => {
    expect(timing('fade', 3, 8, false)).toMatchObject({ duration: FADE_MS, delay: 0 });
    expect(totalMs('fade', 8)).toBe(120);
    const [a, b] = keyframes('fade', A, B, 0);
    expect(a).toMatchObject({ opacity: 0, left: '700px', top: '300px' });
    expect(b).toMatchObject({ opacity: 1, left: '700px', top: '300px' });
  });

  it('an unknown stored style reads as the default Domino', () => {
    expect(parseSwitchStyle(undefined)).toBe('domino');
    expect(parseSwitchStyle('sparkle')).toBe('domino');
    expect(parseSwitchStyle('ink')).toBe('ink');
    expect(parseSwitchStyle('off')).toBe('off');
  });
});

describe('order and the cap of 8', () => {
  it('goes active first, then the other open panes, then the sidebar-only panes', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(orderPanes(ids, 'c', new Set(['c', 'e']))).toEqual(['c', 'e', 'a', 'b', 'd']);
    expect(orderPanes(ids, null, new Set(['b']))).toEqual(['b', 'a', 'c', 'd', 'e']);
    expect(orderPanes(['x', 'x', 'y'], 'y', new Set())).toEqual(['y', 'x']);
  });

  it('animates the active pane plus the next 7; the rest only appear', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `p${i}`);
    const { animated, instant } = splitAnimated(orderPanes(ids, 'p4', new Set(['p4', 'p9'])));
    expect(MAX_ANIMATED).toBe(8);
    expect(animated).toHaveLength(8);
    expect(animated.slice(0, 2)).toEqual(['p4', 'p9']);
    expect(instant).toHaveLength(3);
    expect(splitAnimated(['a']).instant).toEqual([]);
  });

  it('keeps the whole motion inside 770 ms for Domino however many panes there are', () => {
    expect(totalMs('domino', 8)).toBeLessThanOrEqual(770);
  });
});

describe('coming back', () => {
  it('faces crossfade in the middle half of the flight, mirrored on the way back', () => {
    expect(faceFade(500, 80, false)).toEqual({ duration: 250, delay: 80 + 75 });
    expect(faceFade(500, 80, true)).toEqual({ duration: 250, delay: 80 + 250 });
  });
});

describe('screen to overlay pixels', () => {
  it('subtracts the monitor origin and divides by its scale', () => {
    const rect: Rect = { x: -2880 + 300, y: 150, w: 600, h: 300 };
    expect(toLocal(rect, { x: -2880, y: 0, w: 2880, h: 1620, scale: 1.5 })).toEqual({ left: 200, top: 100, width: 400, height: 200 });
  });

  it('a window on another monitor is not on this one', () => {
    const mon = { x: 0, y: 0, w: 1920, h: 1080, scale: 1 };
    expect(onMonitor({ x: 100, y: 100, w: 400, h: 300 }, mon)).toBe(true);
    expect(onMonitor({ x: 1900, y: 100, w: 400, h: 300 }, mon)).toBe(true);
    expect(onMonitor({ x: 2000, y: 100, w: 400, h: 300 }, mon)).toBe(false);
    expect(onMonitor({ x: -500, y: 0, w: 400, h: 300 }, mon)).toBe(false);
  });
});

describe('demo run', () => {
  const mon = { x: 0, y: 0, w: 1920, h: 1080, scale: 1 };
  it('has five panes, two from the sidebar, and lasts as long as its motion', () => {
    const spec = previewSpec('domino', mon, false);
    expect(spec.proxies).toHaveLength(5);
    expect(spec.proxies.filter((p) => p.fromRow)).toHaveLength(2);
    expect(spec.totalMs).toBe(totalMs('domino', 5));
    expect(previewSpec('ink', mon, false).totalMs).toBe(720);
    expect(previewSpec('ink', mon, true).motion).toBe('fade');
  });
});

describe('pickSource', () => {
  const list: Rect = { x: 0, y: 100, w: 240, h: 500 };
  const tile: Rect = { x: 300, y: 120, w: 800, h: 600 };
  const row: Rect = { x: 6, y: 200, w: 228, h: 32 };
  const header: Rect = { x: 6, y: 160, w: 228, h: 28 };

  it('starts from the open grid tile when there is one', () => {
    expect(pickSource({ tile, row, header, list })).toEqual({ rect: tile, kind: 'tile' });
  });

  it('starts from the sidebar row of a pane that is only in the sidebar', () => {
    expect(pickSource({ tile: null, row, header, list })).toEqual({ rect: row, kind: 'row' });
  });

  it('starts from the project header when the project is folded (no row)', () => {
    expect(pickSource({ tile: null, row: null, header, list })).toEqual({ rect: header, kind: 'header' });
  });

  it('starts from the top edge of the list when the row is scrolled up out of view', () => {
    const gone = { ...row, y: 20 };
    const got = pickSource({ tile: null, row: gone, header, list });
    expect(got).toEqual({ rect: { x: 0, y: 100, w: 240, h: 32 }, kind: 'edge' });
  });

  it('starts from the bottom edge when the row is scrolled down out of view', () => {
    const gone = { ...row, y: 900 };
    const got = pickSource({ tile: null, row: gone, header, list });
    expect(got).toEqual({ rect: { x: 0, y: 568, w: 240, h: 32 }, kind: 'edge' });
  });

  it('a folded project whose header is out of view also uses the nearest edge', () => {
    const got = pickSource({ tile: null, row: null, header: { ...header, y: 1200 }, list });
    expect(got?.kind).toBe('edge');
    expect(got?.rect.y).toBe(572);
  });

  it('has nothing to start from without a tile, row or header', () => {
    expect(pickSource({ tile: null, row: null, header: null, list })).toBeNull();
  });

  it('without a list rect the row is used as it is', () => {
    expect(pickSource({ tile: null, row, header: null, list: null })).toEqual({ rect: row, kind: 'row' });
  });
});

describe('what the overlay works out for itself', () => {
  const monitor = { x: 0, y: 0, w: 2560, h: 1440, scale: 2 };
  const proxy = (id: string) => ({
    id,
    start: { x: 100, y: 50, w: 800, h: 600 },
    end: { x: 400, y: 300, w: 1000, h: 700 },
    face: { kind: 'simple' as const, name: 'a', project: 'p', status: 'idle' },
    fromRow: false,
  });

  it('Domino with 2 panes lasts at least 530 ms (530 + 80 stagger); the setting maps to the motion', async () => {
    const { expectedMs, motionFor } = await import('./model');
    expect(expectedMs({ motion: motionFor('domino', false), proxies: [proxy('a'), proxy('b')] })).toBe(610);
    expect(expectedMs({ motion: 'domino', proxies: [proxy('a')] })).toBe(530);
    expect(expectedMs({ motion: motionFor('ink', false), proxies: [proxy('a'), proxy('b')] })).toBe(720);
    expect(expectedMs({ motion: motionFor('off', false), proxies: [proxy('a')] })).toBe(120);
    expect(expectedMs({ motion: motionFor('domino', true), proxies: [proxy('a')] })).toBe(120);
  });

  it('an animation that claims to be finished early is held to the full length', async () => {
    const { holdMs } = await import('./model');
    expect(holdMs(610, 0)).toBe(610);
    expect(holdMs(610, 4)).toBe(606);
    expect(holdMs(610, 610)).toBe(0);
    expect(holdMs(610, 900)).toBe(0);
    expect(holdMs(0, 0)).toBe(0);
    expect(holdMs(610, Number.NaN)).toBe(610);
  });

  it('reports each proxy from and to in the overlay monitor CSS px', async () => {
    const { proxyReport } = await import('./model');
    expect(proxyReport({ monitor, proxies: [proxy('acp-65b2aaaaaaaaaaaa')] })).toEqual([{ id: 'acp-65b2aaaa', from: [50, 25, 400, 300], to: [200, 150, 500, 350] }]);
  });
});
