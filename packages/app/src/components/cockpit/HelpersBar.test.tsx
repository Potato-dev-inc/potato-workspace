// @vitest-environment jsdom
// The helpers bar on its own: the crumb, a chip per helper with its state, the close and menu actions, the standby
// chips, and the words in both languages. The bar inside the cockpit (split view, focus) is tested in CockpitApp.test.tsx.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { t } from '../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import { setStandbys, type Standby } from '../../lib/helper-standbys';
import { setHelpersInSidebar } from '../../lib/helpersInSidebar';
import { cancelDrag } from '../dnd/dragStore';
import { HelpersBar } from './HelpersBar';
import { NEW_STANDBY_EVENT, useStandbyFeed, type StandbyHelperEntry, type StandbyHelpersApi, type StandbyHelpersView } from '../../lib/standbyHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mk = (id: string, status: string, title: string, parent?: string, agent = 'claude') => ({
  status,
  info: { id, agent_type: agent, status, pid: 1, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 100, rows: 30, title, parent_pane_id: parent },
});

let host: HTMLDivElement;
let root: Root;
const select = vi.fn();
const closePane = vi.fn();
const onOpen = vi.fn();
const onOpenBeside = vi.fn();

function api(list: ReturnType<typeof mk>[], prompts: Record<string, unknown> = {}): CockpitApi {
  return { registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])) }, names: new Map(list.map((p) => [p.info.id, 'Claude'])), prompts, select, closePane, notify: vi.fn() } as unknown as CockpitApi;
}
const LIST = [
  mk('a', 'idle', 'Right panel rebuild'),
  mk('h1', 'running', 'Reviewer', 'a', 'codex'),
  mk('h2', 'waiting_input', 'Tests', 'a'),
  mk('h3', 'idle', 'Docs', 'a', 'gemini'),
  mk('h4', 'error', 'Lint', 'a'),
  mk('b', 'idle', 'Other agent'),
];

async function show(c: CockpitApi, focusedId = 'a', shown: string[] = ['a'], standbys: Standby[] = []) {
  await act(async () => root.render(<HelpersBar c={c} focusedId={focusedId} shown={shown} onOpen={onOpen} onOpenBeside={onOpenBeside} standbys={standbys} />));
}
const chip = (id: string) => host.querySelector<HTMLElement>(`[data-pane-tab="${id}"]`)!;

beforeEach(() => {
  localStorage.clear();
  [select, closePane, onOpen, onOpenBeside].forEach((f) => f.mockClear());
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => cancelDrag());
  act(() => root.unmount());
  host.remove();
  useEnglish();
});

describe('helpers bar', () => {
  it('shows only the helpers of the agent in front, never a main agent, and a crumb back to that agent', async () => {
    await show(api(LIST));
    expect(host.querySelector('[data-testid="helpers-bar"]')!.getAttribute('aria-label')).toBeNull();
    expect(host.querySelector('[role="tablist"]')!.getAttribute('aria-label')).toBe('Helpers');
    expect([...host.querySelectorAll('[data-pane-tab]')].map((e) => e.getAttribute('data-pane-tab'))).toEqual(['h1', 'h2', 'h3', 'h4']);
    expect(host.querySelector('[data-testid="helpers-crumb"]')!.textContent).toBe('Right panel rebuild');
    expect(host.querySelector('[data-testid="helpers-crumb"]')!.getAttribute('title')).toBe('Back to this agent');
  });

  it('with a helper in front, the crumb still names the main agent and the helper is the lifted chip', async () => {
    await show(api(LIST), 'h3', ['h3']);
    expect(host.querySelector('[data-testid="helpers-crumb"]')!.textContent).toBe('Right panel rebuild');
    expect(host.querySelector('[data-testid="helpers-crumb"]')!.className).not.toContain('is-on');
    expect(chip('h3').className).toContain('is-on');
    expect(chip('h3').querySelector('[role="tab"]')!.getAttribute('aria-selected')).toBe('true');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="helpers-crumb"]')!.click());
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('draws nothing when the agent has no helpers and there are no standbys', async () => {
    await show(api(LIST), 'b', ['b']);
    expect(host.querySelector('[data-testid="helpers-bar"]')).toBeNull();
  });

  it('chip states: working is a green dot, needs you is orange with words, done is a check, stopped is red with words', async () => {
    await show(api(LIST));
    expect(chip('h1').querySelector('.ck-hchip-dot.is-working')).not.toBeNull();
    expect(chip('h1').textContent).toBe('Reviewer');
    expect(chip('h2').querySelector('.ck-hchip-dot.is-needs')).not.toBeNull();
    expect(chip('h2').textContent).toBe('TestsNeeds you');
    expect(chip('h3').querySelector('[data-testid="helper-check"]')).not.toBeNull();
    expect(chip('h3').textContent).toBe('Docs');
    expect(chip('h4').querySelector('.ck-hchip-dot.is-stopped')).not.toBeNull();
    expect(chip('h4').textContent).toBe('LintStopped');
  });

  it('an open question makes a helper need you even when its status says it is working', async () => {
    await show(api(LIST, { h1: { choices: [] } }));
    expect(chip('h1').textContent).toBe('ReviewerNeeds you');
  });

  it('the tooltip says what it is, who started it and its state', async () => {
    await show(api(LIST));
    expect(chip('h1').querySelector('[role="tab"]')!.getAttribute('title')).toBe('Reviewer \u00b7 Claude \u00b7 started by Right panel rebuild \u00b7 Working');
  });

  it('a click opens the helper, the hover X closes an idle one at once, and a working one asks first', async () => {
    await show(api(LIST));
    await act(async () => chip('h3').querySelector<HTMLButtonElement>('[role="tab"]')!.click());
    expect(onOpen).toHaveBeenCalledWith('h3');
    await act(async () => chip('h3').querySelector<HTMLButtonElement>('.ck-hchip-x')!.click());
    expect(closePane).toHaveBeenCalledWith('h3');
    const asked: unknown[] = [];
    const listen = (e: Event) => asked.push((e as CustomEvent).detail);
    window.addEventListener('pm:pane-action', listen);
    try {
      await act(async () => chip('h1').querySelector<HTMLButtonElement>('.ck-hchip-x')!.click());
    } finally {
      window.removeEventListener('pm:pane-action', listen);
    }
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith('h1');
    expect(asked).toEqual([{ paneId: 'h1', action: 'close' }]);
  });

  it('a middle click closes the helper', async () => {
    await show(api(LIST));
    await act(async () => void chip('h3').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })));
    expect(closePane).toHaveBeenCalledWith('h3');
  });

  it('a right click opens the menu: Open beside, Rename, Stop', async () => {
    await show(api(LIST));
    await act(async () => void chip('h3').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 })));
    const items = [...host.querySelectorAll('[data-testid="helpers-menu"] [role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(['Open beside', 'Rename', 'Stop this helper', 'Keep on standby']);
    await act(async () => (items[0] as HTMLButtonElement).click());
    expect(onOpenBeside).toHaveBeenCalledWith('h3');
    expect(host.querySelector('[data-testid="helpers-menu"]')).toBeNull();
  });

  it('Shift+F10 opens the same menu from the keyboard, and Esc closes it', async () => {
    await show(api(LIST));
    await act(async () => void chip('h3').querySelector('[role="tab"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })));
    expect(host.querySelector('[data-testid="helpers-menu"]')).not.toBeNull();
    await act(async () => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[data-testid="helpers-menu"]')).toBeNull();
  });

  it('chips can be dragged to reorder, and the order is remembered for this agent', async () => {
    const rectOf = (l: number, r: number) => ({ left: l, right: r, top: 0, bottom: 36, width: r - l, height: 36, x: l, y: 0, toJSON() {} }) as DOMRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const id = this.getAttribute('data-pane-tab');
      if (id) {
        const at = [...(this.parentElement?.querySelectorAll('[data-pane-tab]') ?? [])].indexOf(this);
        return rectOf(at * 100, at * 100 + 100);
      }
      return this.getAttribute('role') === 'tablist' ? rectOf(0, 400) : rectOf(0, 0);
    });
    try {
      await show(api(LIST));
      const order = () => [...host.querySelectorAll('[data-pane-tab]')].map((e) => e.getAttribute('data-pane-tab'));
      const fire = (target: EventTarget, type: string, x: number) =>
        act(async () => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 10, button: 0 })));
      await fire(chip('h3'), 'pointerdown', 250);
      await fire(window, 'pointermove', 100);
      await fire(window, 'pointermove', 10);
      await fire(window, 'pointerup', 10);
      await fire(window, 'click', 10); // a browser always sends the click that follows a release
      expect(order()).toEqual(['h3', 'h1', 'h2', 'h4']);
      expect(Object.values(JSON.parse(localStorage.getItem('pm.paneTabs.order') ?? '{}'))).toEqual([['h3', 'h1', 'h2', 'h4']]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('standby chips', () => {
  const standbys: Standby[] = [
    { id: 's1', agent: 'codex', name: 'Reviewer', model: 'gpt-5', state: 'ready' },
    { id: 's2', agent: 'claude', name: 'Quick fixer', state: 'busy' },
  ];
  it('outlined chips after a Standby label: Ready with a hollow ring, in use with the working dot', async () => {
    await show(api(LIST), 'a', ['a'], standbys);
    expect(host.querySelector('.ck-hbar-grp')).toBeNull();
    const [ready, busy] = [...host.querySelectorAll('[data-testid="standby-chip"]')];
    expect(ready.className).toContain('is-standby');
    expect(ready.textContent).toBe('ReviewerReady');
    expect(ready.querySelector('.ck-hchip-ring')).not.toBeNull();
    expect(ready.querySelector('[role="tab"]')!.getAttribute('title')).toBe('Reviewer \u00b7 codex \u00b7 gpt-5 \u00b7 waiting, uses no tokens');
    expect(busy.querySelector('.ck-hchip-dot.is-working')).not.toBeNull();
    expect(busy.textContent).toBe('Quick fixer');
  });

  it('with standbys only, the bar reads crumb, chips and has no helper arrow', async () => {
    await show(api(LIST), 'b', ['b'], standbys);
    expect(host.querySelector('[data-testid="helpers-bar"]')).not.toBeNull();
    expect(host.querySelector('.ck-hbar-gt')).toBeNull();
    expect(host.querySelectorAll('[data-pane-tab]').length).toBe(0);
  });
});

describe('overflow', () => {
  it('chips that do not fit go into a +N menu, but the ones that need you stay in the bar', async () => {
    const many = [mk('a', 'idle', 'Main'), ...Array.from({ length: 8 }, (_, i) => mk(`h${i}`, i === 6 ? 'waiting_input' : 'idle', `Helper ${i}`, 'a'))];
    const RO = globalThis.ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(private cb: () => void) {}
      observe() {
        this.cb();
      }
      unobserve() {}
      disconnect() {}
    };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 640, top: 0, bottom: 36, width: 640, height: 36, x: 0, y: 0, toJSON() {} } as DOMRect);
    try {
      await show(api(many));
      const ids = [...host.querySelectorAll('[data-pane-tab]')].map((e) => e.getAttribute('data-pane-tab'));
      expect(ids).toContain('h6');
      expect(ids.length).toBeLessThan(8);
      const more = host.querySelector<HTMLButtonElement>('[data-testid="helpers-more"]')!;
      expect(more.textContent).toBe(`+${8 - ids.length}`);
      await act(async () => more.click());
      const items = [...host.querySelectorAll('[data-testid="helpers-menu"] [role="menuitem"]')].map((i) => i.textContent);
      expect(items.length).toBe(8 - ids.length);
      expect(items.join(' ')).not.toContain('Helper 6');
    } finally {
      vi.restoreAllMocks();
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
    }
  });
});

describe('words', () => {
  it('speak Traditional Chinese when the app does', async () => {
    useChinese();
    await show(api(LIST), 'a', ['a'], [{ id: 's1', agent: 'codex', name: 'Reviewer', state: 'ready' }]);
    expect(host.querySelector('[role="tablist"]')!.getAttribute('aria-label')).toBe(t('hbar.label'));
    expect(t('hbar.label')).toBe('\u5e6b\u624b');
    expect(chip('h2').textContent).toContain(t('pane.needsYou'));
    expect(chip('h4').textContent).toContain(t('hbar.stopped'));
    expect(host.querySelector('[data-testid="standby-chip"]')!.textContent).toContain(t('hbar.ready'));
    expect(host.querySelector('[data-testid="helpers-crumb"]')!.getAttribute('title')).toBe(t('hbar.back'));
    // Titles and agent names are data; every other word on the bar is translated.
    expect(visibleEnglish(host, ['Right', 'panel', 'rebuild', 'Reviewer', 'Tests', 'Docs', 'Lint'])).toEqual([]);
  });
});

describe('helpers bar: making standbys', () => {
  beforeEach(() => setHelpersInSidebar(false));
  afterEach(() => setHelpersInSidebar(true));
  it('the "+" asks the cockpit for the Add a helper popover, with the folder and the agent it goes under', async () => {
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(NEW_STANDBY_EVENT, on);
    await show(api(LIST));
    await act(async () => host.querySelector<HTMLElement>('[data-testid="standby-add"]')!.click());
    window.removeEventListener(NEW_STANDBY_EVENT, on);
    expect(seen).toEqual([{ project: LIST[0].info.cwd, home: 'a', anchor: expect.any(Object) }]);
  });

  it('only the standbys for the project in front are drawn', async () => {
    const here: Standby = { id: 's1', agent: 'codex', name: 'Reviewer', state: 'ready', project: 'C:/work/shop' };
    const there: Standby = { id: 's2', agent: 'codex', name: 'Docs', state: 'ready', project: 'C:/other' };
    await show(api(LIST), 'a', ['a'], [here, there]);
    expect([...host.querySelectorAll('[data-testid="standby-chip"]')].map((e) => e.textContent)).toEqual([expect.stringContaining('Reviewer')]);
  });

  it('a finished helper offers "Keep on standby" in its menu', async () => {
    await show(api(LIST));
    await act(async () => {
      chip('h3').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    });
    expect([...host.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent)).toContain('Keep on standby');
    await act(async () => {
      chip('h1').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    });
    expect([...host.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent)).not.toContain('Keep on standby');
  });
});

describe('a standby through a task (the feed and the bar together)', () => {
  beforeEach(() => setHelpersInSidebar(false));
  afterEach(() => setHelpersInSidebar(true));
  const entry = (state: StandbyHelperEntry['state']): StandbyHelperEntry => ({ id: 's1', name: 'Reviewer', agent: 'codex', model: 'gpt-5', project: 'C:/work/shop', after_task: 'wait', state, note: null, pane_id: state === 'busy' ? 'chat-1' : null, home: null, used_by: state === 'busy' ? 'agent' : null, taken_over: false, open_pane: null, person_pane: null });

  it('run_agent takes it: Working, then Starting…, then Ready. The chip is never absent', async () => {
    vi.useFakeTimers();
    try {
      let current: StandbyHelpersView = { helpers: [entry('ready')], max: 4, idle_minutes: 30 };
      const get = vi.fn(async () => current);
      const standbyApi = { get } as unknown as StandbyHelpersApi;
      function Screen() {
        useStandbyFeed(standbyApi);
        return <HelpersBar c={api(LIST)} focusedId="a" shown={['a']} onOpen={onOpen} onOpenBeside={onOpenBeside} />;
      }
      const chips = () => [...host.querySelectorAll<HTMLElement>('[data-testid="standby-chip"]')];
      const next = async (state: StandbyHelperEntry['state']) => {
        current = { ...current, helpers: [entry(state)] };
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
      };
      await act(async () => root.render(<Screen />));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(chips().map((c) => c.dataset.state)).toEqual(['ready']);
      await next('busy');
      expect(chips().map((c) => c.dataset.state)).toEqual(['working']);
      await next('starting');
      expect(chips().map((c) => c.dataset.state)).toEqual(['starting']);
      expect(chips()[0].textContent).toBe('ReviewerStarting…');
      await next('ready');
      expect(chips().map((c) => c.dataset.state)).toEqual(['ready']);
    } finally {
      vi.useRealTimers();
      act(() => setStandbys([]));
    }
  });
});

describe('removing a standby from the bar', () => {
  beforeEach(() => setHelpersInSidebar(false));
  afterEach(() => setHelpersInSidebar(true));
  const one: Standby[] = [{ id: 's1', agent: 'opencode', name: 'Reviewer', model: 'gpt-5', state: 'ready', project: 'C:/work/shop' }];
  const mkApi = () => ({ remove: vi.fn(async () => null), add: vi.fn(async () => null) }) as unknown as StandbyHelpersApi & { remove: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn> };
  const mount = async (standbyApi: StandbyHelpersApi) => {
    act(() => setStandbys(one));
    await act(async () => root.render(<HelpersBar c={api(LIST)} focusedId="a" shown={['a']} onOpen={onOpen} standbyApi={standbyApi} />));
  };
  afterEach(() => act(() => setStandbys([])));

  it('the X on a chip removes it, closes its session, and Undo makes it again', async () => {
    const a = mkApi();
    await mount(a);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="standby-remove"]')!.click());
    expect(a.remove).toHaveBeenCalledWith('s1');
    expect(host.querySelector('[data-testid="standby-chip"]')).toBeNull();
    expect(host.querySelector('[data-testid="standby-undo"]')!.textContent).toContain('Reviewer removed.');
    await act(async () => [...host.querySelectorAll('[data-testid="standby-undo"] button')][0].dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(a.add).toHaveBeenCalledWith(expect.objectContaining({ name: 'Reviewer', agent: 'opencode', model: 'gpt-5', project: 'C:/work/shop' }));
    expect(host.querySelector('[data-testid="standby-undo"]')).toBeNull();
  });

  it('right-click shows "Remove standby"', async () => {
    const a = mkApi();
    await mount(a);
    await act(async () => host.querySelector('[data-testid="standby-chip"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    const item = host.querySelector<HTMLButtonElement>('[data-testid="helpers-menu"] [role="menuitem"]')!;
    expect(item.textContent).toBe('Remove standby');
    await act(async () => item.click());
    expect(a.remove).toHaveBeenCalledWith('s1');
  });
});

describe('with the sidebar list on (the default)', () => {
  it('the sidebar shows the standbys: the live feed draws no chips here and there is no + button', async () => {
    act(() => setStandbys([{ id: 's1', agent: 'codex', name: 'Reviewer', state: 'ready', project: 'C:/work/shop' }]));
    await act(async () => root.render(<HelpersBar c={api(LIST)} focusedId="a" shown={['a']} onOpen={onOpen} />));
    expect(host.querySelector('[data-testid="standby-chip"]')).toBeNull();
    expect(host.querySelector('[data-testid="standby-add"]')).toBeNull();
    act(() => setStandbys([]));
  });
});
