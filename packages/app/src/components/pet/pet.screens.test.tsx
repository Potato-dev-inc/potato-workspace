// @vitest-environment jsdom
// Desktop Potato at screen level: the pet reacts to the app (needs you, finished), a click opens that agent, the
// menu does what it says, Less motion stills it, quiet hours silence it, and a resting pet runs no animation.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PetHost, type PetHostProps } from './PetHost';
import { PetSprite, frameAt, framePosition } from './PetSprite';
import { CELEBRATE_MS, SLEEP_AFTER_MS, WAVE_MS, SPRITE_FRAMES } from './petModel';
import type { PetApi } from './petApi';
import type { PetEnv } from './usePetController';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
let movedCallbacks: Array<() => void>;

function makeApi() {
  movedCallbacks = [];
  const api: PetApi & { calls: Record<string, unknown[][]> } = {
    calls: { expanded: [], drag: [], open: [], patch: [] },
    env: { moveBy: vi.fn(async () => false), fullscreenBusy: vi.fn(async () => false) },
    setExpanded(v) {
      api.calls.expanded.push([v]);
    },
    startDrag() {
      api.calls.drag.push([]);
    },
    openAgent(id) {
      api.calls.open.push([id]);
    },
    patch(p) {
      api.calls.patch.push([p]);
    },
    onMoved: async (cb) => {
      movedCallbacks.push(cb);
      return () => undefined;
    },
  };
  return api;
}

const envOf = (api: PetApi): PetEnv => ({ now: () => Date.now(), random: () => 0.5, ...api.env });

function props(api: ReturnType<typeof makeApi>, over: Partial<PetHostProps> = {}): PetHostProps {
  return { needs: [], finished: null, size: 'medium', quietChoice: false, quiet: false, lessMotion: false, api, env: envOf(api), ...over };
}

const q = (selector: string) => host.querySelector<HTMLElement>(selector);
const sprite = () => q('.pet-sprite')!.dataset.sprite;
const render = (p: PetHostProps) => act(async () => root.render(<PetHost {...p} />));
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: 5, clientY: 5 }));
    el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 5, clientY: 5 }));
  });
/** Time passes in small steps, as it does for real: the pet sets its next timer only after it has drawn. */
const fresh = async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
};
const advance = async (ms: number) => {
  for (let left = ms; left > 0; left -= 2_000) await act(async () => void vi.advanceTimersByTime(Math.min(2_000, left)));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(2026, 10, 13, 12, 0, 0));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('Desktop Potato screen', () => {
  it('starts awake and still, with no bubble, and sleeps when nothing happens', async () => {
    const api = makeApi();
    await render(props(api));
    expect(sprite()).toBe('idle');
    expect(q('.pet-bubble')).toBeNull();
    expect(q('.pet-sprite')!.dataset.play).toBe('still');
    await advance(SLEEP_AFTER_MS + 100);
    expect(sprite()).toBe('sleep');
  });

  it('an agent needs you: it waves, the bubble names the agent, and the window asks for room', async () => {
    const api = makeApi();
    await render(props(api, { needs: [{ key: 'approval:p1', paneId: 'p1', agent: 'Claude' }] }));
    expect(sprite()).toBe('wave-hello');
    expect(q('.pet-bubble')!.textContent).toContain('Claude needs you');
    expect(api.calls.expanded.at(-1)).toEqual([true]);
    await advance(WAVE_MS + 50);
    expect(sprite()).toBe('needs-you');
  });

  it('clicking the Potato opens that agent in the main window', async () => {
    const api = makeApi();
    await render(props(api, { needs: [{ key: 'approval:p7', paneId: 'p7', agent: 'Codex' }] }));
    await click(q('.pet-body')!);
    expect(api.calls.open).toEqual([['p7']]);
  });

  it('Open in the bubble opens the agent too, and Later hides the bubble but keeps waving for you', async () => {
    const api = makeApi();
    await render(props(api, { needs: [{ key: 'approval:p7', paneId: 'p7', agent: 'Codex' }] }));
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('.pet-bubble button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['Open', 'Later']);
    await act(async () => buttons[1].click());
    expect(q('.pet-bubble')).toBeNull();
    expect(api.calls.expanded.at(-1)).toEqual([false]);
    expect(sprite()).toBe('wave-hello');
    await advance(WAVE_MS + 50);
    expect(sprite()).toBe('needs-you');
    expect(api.calls.open).toEqual([]);
  });

  it('a finished run: it celebrates, says so, and goes back to rest', async () => {
    const api = makeApi();
    await render(props(api, { finished: { n: 1, agent: 'Gemini', paneId: 'p2' } }));
    expect(sprite()).toBe('celebrate');
    expect(q('.pet-bubble')!.textContent).toContain('Gemini finished');
    await click(q('.pet-body')!);
    expect(api.calls.open).toEqual([['p2']]);
    await render(props(api, { finished: { n: 1, agent: 'Gemini', paneId: 'p2' } }));
    await advance(CELEBRATE_MS + 7_000);
    expect(sprite()).toBe('idle');
    expect(q('.pet-bubble')).toBeNull();
  });

  it('the same finished event is not celebrated twice, a new one is', async () => {
    const api = makeApi();
    const first = { n: 1, agent: 'Gemini', paneId: 'p2' };
    await render(props(api, { finished: first }));
    await advance(CELEBRATE_MS + 7_000);
    await render(props(api, { finished: { ...first } }));
    expect(sprite()).toBe('idle');
    await render(props(api, { finished: { ...first, n: 2 } }));
    expect(sprite()).toBe('celebrate');
  });

  it('quiet hours: asleep, no wave, no bubble, no celebration', async () => {
    const api = makeApi();
    await render(props(api, { quiet: true, needs: [{ key: 'approval:p1', paneId: 'p1', agent: 'Claude' }], finished: { n: 1, agent: 'Claude' } }));
    expect(sprite()).toBe('sleep');
    expect(q('.pet-bubble')).toBeNull();
    expect(q('.pet-body')!.getAttribute('aria-label')).toContain('quiet');
    expect(api.calls.expanded.every((c) => c[0] === false)).toBe(true);
  });

  it('Less motion: a still frame for waving and no walking', async () => {
    const api = makeApi();
    await render(props(api, { lessMotion: true, needs: [{ key: 'approval:p1', paneId: 'p1', agent: 'Claude' }] }));
    expect(sprite()).toBe('wave-hello');
    expect(q('.pet-sprite')!.dataset.play).toBe('still');
    expect(q('.pet-sprite')!.dataset.frame).toBe('0');
    await render(props(api, { lessMotion: true }));
    await advance(10 * 60_000);
    expect(api.env.fullscreenBusy).not.toHaveBeenCalled();
    expect(api.env.moveBy).not.toHaveBeenCalled();
  });

  it('it walks now and then, not near a full-screen app and not when that cannot be told', async () => {
    const api = makeApi();
    await render(props(api));
    await advance(212_000);
    expect(api.env.fullscreenBusy).toHaveBeenCalled();
    expect(sprite()).toMatch(/^walk-/);
    await advance(500);
    expect(api.env.moveBy).toHaveBeenCalled();

    await fresh();
    const busy = makeApi();
    (busy.env.fullscreenBusy as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await render(props(busy, { size: 'small' }));
    await advance(230_000);
    expect(busy.env.fullscreenBusy).toHaveBeenCalled();
    expect(busy.env.moveBy).not.toHaveBeenCalled();

    await fresh();
    const unknown = makeApi();
    (unknown.env.fullscreenBusy as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await render(props(unknown, { size: 'large' }));
    await advance(230_000);
    expect(unknown.env.moveBy).not.toHaveBeenCalled();
  });

  it('dragging: the window is dragged, the Potato shows the dragged frames and lands when it settles', async () => {
    const api = makeApi();
    await render(props(api));
    await act(async () => {
      const body = q('.pet-body')!;
      body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: 5, clientY: 5 }));
      body.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 1, clientX: 30, clientY: 5 }));
    });
    expect(api.calls.drag).toHaveLength(1);
    expect(sprite()).toBe('dragged');
    expect(api.calls.open).toEqual([]);
    await act(async () => movedCallbacks.forEach((cb) => cb()));
    expect(sprite()).toBe('land');
    await advance(900);
    expect(sprite()).toBe('idle');
  });

  it('a press that does not move is a click, not a drag', async () => {
    const api = makeApi();
    await render(props(api));
    await click(q('.pet-body')!);
    expect(api.calls.drag).toHaveLength(0);
    expect(q('.pet-menu')).not.toBeNull();
  });

  it('right-click opens the menu; each item does what it says', async () => {
    const api = makeApi();
    await render(props(api));
    const open = () => act(async () => void q('.pet-body')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    await open();
    const menu = q('.pet-menu')!;
    expect(menu.getAttribute('role')).toBe('menu');
    expect(Array.from(menu.querySelectorAll('[role^="menuitem"]')).map((b) => b.textContent!.replace('✓', '').trim())).toEqual([
      'Hide for 1 hour',
      'Small',
      'Medium',
      'Large',
      'Quiet',
      'Turn off',
    ]);
    expect(api.calls.expanded.at(-1)).toEqual([true]);

    await act(async () => menu.querySelectorAll<HTMLElement>('[role="menuitem"]')[0].click());
    const hide = api.calls.patch[0][0] as { desktop_pet_hidden_until_ms: number };
    expect(hide.desktop_pet_hidden_until_ms).toBe(Date.now() + 60 * 60_000);
    expect(q('.pet-menu')).toBeNull();

    await open();
    await act(async () => q('.pet-menu [role="menuitemradio"][aria-checked="false"]')!.click());
    expect(api.calls.patch[1][0]).toEqual({ desktop_pet_size: 'small' });

    await open();
    await act(async () => q('.pet-menu [role="menuitemcheckbox"]')!.click());
    expect(api.calls.patch[2][0]).toEqual({ desktop_pet_quiet: true });

    await open();
    await act(async () => Array.from(host.querySelectorAll<HTMLElement>('.pet-menu [role="menuitem"]')).at(-1)!.click());
    expect(api.calls.patch[3][0]).toEqual({ desktop_pet_enabled: false });
  });

  it('the menu shows the current size and quiet choice, and works from the keyboard', async () => {
    const api = makeApi();
    await render(props(api, { size: 'large', quietChoice: true }));
    await act(async () => void q('.pet-body')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ContextMenu' })));
    expect(q('.pet-menu [aria-checked="true"][role="menuitemradio"]')!.textContent).toBe('Large');
    expect(q('.pet-menu [role="menuitemcheckbox"]')!.getAttribute('aria-checked')).toBe('true');
    const items = Array.from(host.querySelectorAll<HTMLElement>('.pet-menu [role^="menuitem"]'));
    expect(document.activeElement).toBe(items[0]);
    await act(async () => void items[0].dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' })));
    expect(document.activeElement).toBe(items[1]);
    await act(async () => void items[1].dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' })));
    await act(async () => void items[0].dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' })));
    expect(document.activeElement).toBe(items.at(-1));
    await act(async () => void items.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })));
    expect(q('.pet-menu')).toBeNull();
    expect(document.activeElement).toBe(q('.pet-body'));
  });

  it('Enter on the Potato opens the waiting agent', async () => {
    const api = makeApi();
    await render(props(api, { needs: [{ key: 'approval:p3', paneId: 'p3', agent: 'Claude' }] }));
    expect(q('.pet-body')!.getAttribute('aria-label')).toContain('1 agent needs you');
    await act(async () => void q('.pet-body')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })));
    expect(api.calls.open).toEqual([['p3']]);
  });
});

describe('the sprite', () => {
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a still picture asks for no animation frames at all', async () => {
    await act(async () => root.render(<PetSprite sprite="idle" play="still" size={128} />));
    await act(async () => root.render(<PetSprite sprite="sleep" play="still" size={128} />));
    expect(frames).toHaveLength(0);
  });

  it('a looping state steps through its frames at 12 per second', async () => {
    await act(async () => root.render(<PetSprite sprite="walk-left" play="loop" size={128} />));
    expect(frames).toHaveLength(1);
    const el = q('.pet-sprite')!;
    await act(async () => frames.shift()!(1_000));
    await act(async () => frames.shift()!(1_000 + 250));
    expect(el.dataset.frame).toBe('3');
    await act(async () => frames.shift()!(1_000 + 1_000));
    expect(el.dataset.frame).toBe('0');
  });

  it('a one-shot state stops asking for frames on its last frame', async () => {
    await act(async () => root.render(<PetSprite sprite="land" play="once" size={96} />));
    await act(async () => frames.shift()!(0));
    await act(async () => frames.shift()!(5_000));
    expect(q('.pet-sprite')!.dataset.frame).toBe(String(SPRITE_FRAMES.land - 1));
    expect(frames).toHaveLength(0);
  });

  it('frame maths', () => {
    expect(frameAt(0, 12, 'loop')).toBe(0);
    expect(frameAt(1_000, 12, 'loop')).toBe(0);
    expect(frameAt(500, 12, 'loop')).toBe(6);
    expect(frameAt(9_999, 9, 'once')).toBe(8);
    expect(frameAt(9_999, 9, 'still')).toBe(0);
    expect(framePosition(0, 12)).toBe('0%');
    expect(framePosition(11, 12)).toBe('100%');
    expect(framePosition(0, 1)).toBe('0%');
  });
});
