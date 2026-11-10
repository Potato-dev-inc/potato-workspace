// @vitest-environment jsdom
// Where each pane's proxy starts, read from the real cockpit DOM shape: tile, sidebar row, folded project header,
// or the nearest edge of the sidebar list when the row is scrolled out of view.
import { afterEach, describe, expect, it } from 'vitest';
import { collectProxies, openTileIds, sourceFor } from './collect';

type Box = [number, number, number, number];

function rect(el: Element, [left, top, width, height]: Box) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

const ORIGIN = { x: 100, y: 50 };

function cockpit(): { root: HTMLElement; list: HTMLElement } {
  document.body.innerHTML = `
    <div class="cockpit">
      <div class="ck-side-scroll" style="overflow-y:auto">
        <div class="ck-proj" data-pane-ids="a b"><div class="ck-proj-head"></div>
          <button data-pane-row="a"></button><button data-pane-row="b"></button></div>
        <div class="ck-proj" data-pane-ids="c"><div class="ck-proj-head"></div></div>
      </div>
      <div data-pane-tile="a"></div>
    </div>`;
  const root = document.body;
  const list = root.querySelector<HTMLElement>('.ck-side-scroll')!;
  rect(list, [0, 100, 240, 500]);
  rect(root.querySelector('[data-pane-tile="a"]')!, [260, 80, 800, 600]);
  rect(root.querySelector('[data-pane-row="a"]')!, [6, 200, 228, 32]);
  rect(root.querySelector('[data-pane-row="b"]')!, [6, 240, 228, 32]);
  const heads = root.querySelectorAll('.ck-proj-head');
  rect(heads[0], [6, 160, 228, 28]);
  rect(heads[1], [6, 300, 228, 28]);
  return { root, list };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('sourceFor', () => {
  it('an open pane starts at its tile, in physical screen pixels', () => {
    const { root } = cockpit();
    const got = sourceFor(root, 'a', ORIGIN, 2);
    expect(got?.kind).toBe('tile');
    expect(got?.rect).toEqual({ x: 100 + 260 * 2, y: 50 + 80 * 2, w: 1600, h: 1200 });
  });

  it('a pane that is only in the sidebar starts at its row', () => {
    const { root } = cockpit();
    const got = sourceFor(root, 'b', ORIGIN, 1);
    expect(got?.kind).toBe('row');
    expect(got?.rect).toEqual({ x: 106, y: 290, w: 228, h: 32 });
  });

  it('a pane in a folded project (no row) starts at the project header', () => {
    const { root } = cockpit();
    const got = sourceFor(root, 'c', ORIGIN, 1);
    expect(got?.kind).toBe('header');
    expect(got?.rect).toEqual({ x: 106, y: 350, w: 228, h: 28 });
  });

  it('a row scrolled out of the list starts at the nearest edge of the list', () => {
    const { root } = cockpit();
    rect(root.querySelector('[data-pane-row="b"]')!, [6, 20, 228, 32]);
    const up = sourceFor(root, 'b', ORIGIN, 1);
    expect(up?.kind).toBe('edge');
    expect(up?.rect).toEqual({ x: 100, y: 150, w: 240, h: 32 });
    rect(root.querySelector('[data-pane-row="b"]')!, [6, 900, 228, 32]);
    const down = sourceFor(root, 'b', ORIGIN, 1);
    expect(down?.kind).toBe('edge');
    expect(down?.rect).toEqual({ x: 100, y: 50 + 568, w: 240, h: 32 });
  });

  it('a pane with nothing in the cockpit has no start', () => {
    const { root } = cockpit();
    expect(sourceFor(root, 'zzz', ORIGIN, 1)).toBeNull();
  });
});

describe('collectProxies', () => {
  const monitor = { x: 0, y: 0, w: 3840, h: 2160, scale: 1 };
  const describePane = (id: string) => ({ name: id.toUpperCase(), project: 'proj', status: 'idle' });
  const windows = ['a', 'b', 'c'].map((id, i) => ({ id, rect: { x: 400 + i * 40, y: 300, w: 500, h: 400 } }));

  it('puts the active pane first, then open tiles, then sidebar-only panes; only tiles skip the row crossfade', () => {
    const { root } = cockpit();
    expect(openTileIds(root)).toEqual(new Set(['a']));
    const proxies = collectProxies({ root, windows, activeId: 'a', origin: ORIGIN, dpr: 1, monitor, describe: describePane });
    expect(proxies.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(proxies.map((p) => p.fromRow)).toEqual([false, true, true]);
    expect(proxies[0].face).toMatchObject({ kind: 'simple', name: 'A' });
  });

  it('falls back to the simple face when the tile has no canvas to copy', () => {
    const { root } = cockpit();
    const proxies = collectProxies({ root, windows, activeId: 'a', origin: ORIGIN, dpr: 1, monitor, describe: describePane, snapshots: true });
    expect(proxies[0].face.kind).toBe('simple');
  });

  it('skips a pane whose window opens on another monitor', () => {
    const { root } = cockpit();
    const far = [{ id: 'a', rect: { x: 5000, y: 100, w: 500, h: 400 } }, windows[1]];
    const proxies = collectProxies({ root, windows: far, activeId: 'a', origin: ORIGIN, dpr: 1, monitor, describe: describePane });
    expect(proxies.map((p) => p.id)).toEqual(['b']);
  });

  it('animates at most 8 panes', () => {
    const { root } = cockpit();
    const list = root.querySelector('.ck-side-scroll')!;
    const many = Array.from({ length: 12 }, (_, i) => `x${i}`);
    for (const id of many) {
      const row = document.createElement('button');
      row.dataset.paneRow = id;
      list.appendChild(row);
      rect(row, [6, 400, 228, 32]);
    }
    const wins = many.map((id, i) => ({ id, rect: { x: 400 + i * 10, y: 300, w: 500, h: 400 } }));
    const proxies = collectProxies({ root, windows: wins, activeId: null, origin: ORIGIN, dpr: 1, monitor, describe: describePane });
    expect(proxies).toHaveLength(8);
  });
});
