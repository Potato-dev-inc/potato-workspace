// @vitest-environment jsdom
// The mark-up bar inside the agent browser's window: a script Rust puts into the page (`markup/bar.js`). This test loads
// the real script with the real shared spec, draws it in jsdom, and uses it. It must live only in the top document, in a
// closed shadow root, keep its queue away from the page, and match the app's own bar (one spec, one set of words).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import spec from './markup-spec.json';

const SRC = resolve(__dirname, '../../../src-tauri/src/markup');
const BAR_JS = readFileSync(resolve(SRC, 'bar.js'), 'utf8');
const BAR_RS = readFileSync(resolve(SRC, 'bar.rs'), 'utf8');

type Api = { set: (json: string) => void; take: () => string | null; shoot: (on: boolean) => void; state: () => string };
let loads = 0;
let roots: ShadowRoot[] = [];
const realAttach = Element.prototype.attachShadow;
const realAdd = EventTarget.prototype.addEventListener;
const realRect = Element.prototype.getBoundingClientRect;
const realAt = (Document.prototype as unknown as { elementFromPoint?: unknown }).elementFromPoint;
let under: Element | null = null;
/** Every listener a loaded bar put on the window or the document, so one test's bar never hears the next test's keys. */
let added: Array<() => void> = [];

/** Words: every key answers with its own name, so a missing word shows as a test failure elsewhere (see the parity test). */
const words = new Proxy({}, { get: (_t, k) => String(k) });

function load(win: Window = window): { key: string; api: Api } {
  const key = `__pm_test_markup_${++loads}`;
  const js = BAR_JS.replace('__PM_MARKUP_KEY__', JSON.stringify(key)).replace('__PM_MARKUP_SPEC__', JSON.stringify(spec)).replace('__PM_MARKUP_LOGOS__', '{"claude":{"path":"M0 0h24v24H0z","dark":null,"light":null}}').replace('__PM_MARKUP_STR__', '{"en":__WORDS__,"zh-TW":__WORDS__}').replace('__PM_MARKUP_TOP__', '36');
  const words2 = js.replace(/__WORDS__/g, 'new Proxy({}, { get: function (t, k) { return String(k); } })');
  new (win as unknown as { Function: FunctionConstructor }).Function(words2)();
  return { key, api: (win as unknown as Record<string, Api>)[key] };
}

const flat = (text: string) => text.replace(/\s+/g, '');
const root = () => roots[0];
const q = <T extends Element = HTMLElement>(sel: string) => root().querySelector<T>(sel);
const btn = (label: string) => [...root().querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label) as HTMLButtonElement;
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: 0, clientY: 100 }));
/** A real mouse click: composed, so it leaves the bar's shadow root and reaches the page's document listeners first. */
const press = (el: Element) => {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const Ctor = type.startsWith('pointer') && typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, clientX: 60, clientY: 170, button: 0 }));
  }
};
const events = (api: Api) => JSON.parse(api.take() ?? '[]') as Array<Record<string, unknown>>;

beforeEach(() => {
  roots = [];
  added = [];
  // jsdom cannot make a trusted event: every listener is told its events are the person's.
  EventTarget.prototype.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (typeof listener !== 'function') return realAdd.call(this, type, listener, options);
    const wrapped = (e: Event) => listener.call(this, new Proxy(e, { get: (t, k) => (k === 'isTrusted' ? true : typeof (t as never)[k] === 'function' ? ((t as never)[k] as () => unknown).bind(t) : (t as never)[k]) }));
    added.push(() => this.removeEventListener(type, wrapped, options));
    return realAdd.call(this, type, wrapped, options);
  };
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const r = realAttach.call(this, init);
    roots.push(r);
    expect(init.mode).toBe('closed');
    return r;
  };
  (Document.prototype as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => under;
  document.body.innerHTML = '<main><a id="buy" class="btn">Buy now</a><iframe id="frame"></iframe></main>';
  under = document.getElementById('buy');
  // The bar reads boxes through the built-in it took at start, so the box is given on the prototype.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return this.id === 'buy' ? ({ x: 10, y: 150, left: 10, top: 150, right: 110, bottom: 190, width: 100, height: 40, toJSON: () => ({}) } as DOMRect) : realRect.call(this);
  };
});
afterEach(() => {
  added.forEach((off) => off());
  EventTarget.prototype.addEventListener = realAdd;
  Element.prototype.attachShadow = realAttach;
  Element.prototype.getBoundingClientRect = realRect;
  (Document.prototype as unknown as { elementFromPoint?: unknown }).elementFromPoint = realAt;
  delete document.documentElement.dataset.motion;
});

const open = (api: Api) => api.set(JSON.stringify({ open: true, theme: 'dark', targets: [{ id: 'pane-1', agent: 'claude', name: 'Claude', task: 'Pricing', project: 'shop', status: 'working', ok: true, reason: null }, { id: 'pane-2', agent: 'codex', name: 'Codex', task: '', project: 'blog', status: 'waiting', ok: true, reason: null }], to: 'pane-1', ownerId: 'pane-1' }));

describe('where it lives', () => {
  it('is in the top document only, in a closed shadow root the page cannot read, under a name the page does not know', () => {
    const { key, api } = load();
    expect(api).toBeTruthy();
    expect(Object.keys(window)).not.toContain(key);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(window, key)?.writable).toBe(false);
    open(api);
    expect(roots).toHaveLength(1);
    const host = document.documentElement.lastElementChild as HTMLElement;
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(host.shadowRoot).toBeNull();
    // Nothing of it is findable by the page.
    expect(document.body.querySelector('[role="toolbar"]')).toBeNull();
  });

  it('does nothing inside a frame', () => {
    const frame = document.getElementById('frame') as HTMLIFrameElement;
    const { api } = load(frame.contentWindow!);
    expect(api).toBeUndefined();
  });

  it('the page cannot read its queue: only take() empties it and the answer is a string', () => {
    const { api } = load();
    open(api);
    click(btn('close'));
    const first = api.take();
    expect(typeof first).toBe('string');
    expect(api.take()).toBeNull();
  });
});

describe('a real mouse press on the bar', () => {
  // Regression: the document's capture listeners held every press back from the page, the bar's own buttons included,
  // so no button of the bar ever ran (the older tests used a non-composed click, which never reaches the document).
  it('switches tools, opens the colour menu and closes the bar', () => {
    const { api } = load();
    open(api);
    press(btn('pen'));
    expect(btn('pen').getAttribute('aria-pressed')).toBe('true');
    press(btn('text'));
    expect(btn('text').getAttribute('aria-pressed')).toBe('true');
    press(btn('select'));
    expect(btn('select').getAttribute('aria-pressed')).toBe('true');
    press(btn('colour'));
    expect(q('[role="menu"]')).not.toBeNull();
    press(btn('close'));
    expect(events(api).map((e) => e.kind)).toContain('close');
  });

  it('a press on the bar never reaches the page button under it', () => {
    const { api } = load();
    open(api);
    let pageRan = false;
    document.getElementById('buy')!.addEventListener('click', () => (pageRan = true));
    press(btn('pen'));
    expect(pageRan).toBe(false);
    expect(btn('pen').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('the bar', () => {
  it('shows every tool, opens and closes with an event for Rust (it pauses the agent), and is hidden until opened', () => {
    const { api } = load();
    expect(roots).toHaveLength(0);
    open(api);
    expect((document.documentElement.lastElementChild as HTMLElement).style.display).toBe('block');
    for (const label of ['select', 'pen', 'shape', 'text', 'colour', 'undo', 'clear', 'close']) expect(btn(label), label).toBeTruthy();
    expect(q('[role="toolbar"]')).not.toBeNull();
    expect(events(api).map((e) => e.kind)).toEqual(['open']);
    click(btn('close'));
    expect(events(api).map((e) => e.kind)).toEqual(['close']);
    expect((document.documentElement.lastElementChild as HTMLElement).style.display).toBe('none');
  });

  it('the active tool is shown by aria-pressed, and the keys pick tools', () => {
    const { api } = load();
    open(api);
    expect(btn('select').getAttribute('aria-pressed')).toBe('true');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    expect(btn('pen').getAttribute('aria-pressed')).toBe('true');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(btn('shape').getAttribute('aria-pressed')).toBe('true');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(btn('select').getAttribute('aria-pressed')).toBe('true');
  });

  it('Select picks the element under the mouse and the page click never runs', () => {
    const { api } = load();
    open(api);
    events(api);
    let pageClicks = 0;
    document.getElementById('buy')!.addEventListener('click', () => (pageClicks += 1));
    click(document.getElementById('buy')!);
    expect(pageClicks).toBe(0);
    expect(root().querySelectorAll('circle')).toHaveLength(1);
    expect(btn('select')).toBeTruthy();
  });

  it('draws a mark with the pen, sends the marks with their elements (Rust cleans them) and the picture comes back into the row', () => {
    const { api } = load();
    open(api);
    events(api);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    const ink = q('svg')!;
    const at = (type: string, x: number, y: number) => ink.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    at('pointerdown', 20, 160);
    at('pointermove', 100, 200);
    at('pointerup', 100, 200);
    expect(root().querySelectorAll('circle')).toHaveLength(1);
    // Send to chat: one prepare event with the mark and the element under it; the row waits for the picture.
    const send = [...root().querySelectorAll('button')].find((b) => b.textContent?.startsWith('sendCount') || b.textContent === 'sendToChat')!;
    click(send);
    const prepare = events(api).find((e) => e.kind === 'prepare') as { marks: Array<{ type: string; near: { tag: string } | null }>; vw: number };
    expect(prepare.marks).toEqual([{ type: 'rect', near: expect.objectContaining({ tag: 'a' }) }]);
    api.set(JSON.stringify({ thumb: 'data:image/png;base64,AAAA', taking: false }));
    expect(q<HTMLCanvasElement>('canvas[role="img"]')!.style.display).toBe('block'); // the picture is drawn into a canvas (no img src for a page policy to block)
    // The person writes what should change and presses Send in the row.
    const req = q<HTMLInputElement>('input[aria-label="request"]')!;
    req.value = 'make it bigger';
    req.dispatchEvent(new Event('input', { bubbles: true }));
    click([...root().querySelectorAll('button')].find((b) => b.textContent === 'send')!);
    const sent = events(api).find((e) => e.kind === 'send') as { request: string; marks: unknown[]; to: string };
    expect(sent.request).toBe('make it bigger');
    expect(sent.marks).toHaveLength(1);
    // After Rust says it went, the marks are gone.
    api.set(JSON.stringify({ sent: true }));
    expect(root().querySelectorAll('circle')).toHaveLength(0);
  });

  it('Send with nothing to say asks for words instead of sending', () => {
    const { api } = load();
    open(api);
    events(api);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    const ink = q('svg')!;
    const at = (type: string, x: number, y: number) => ink.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    at('pointerdown', 5, 5);
    at('pointermove', 30, 30);
    at('pointermove', 60, 60);
    at('pointerup', 60, 60);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    api.set(JSON.stringify({ taking: false, noPicture: true }));
    click([...root().querySelectorAll('button')].find((b) => b.textContent === 'send')!);
    expect(events(api).some((e) => e.kind === 'send')).toBe(false);
    expect(q<HTMLInputElement>('input[aria-label="request"]')!.getAttribute('placeholder')).toBe('requestNeeded');
  });
});

describe('the outline', () => {
  const move = (x: number, y: number) => document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));

  it('is one box that is moved and eases with the spring from the spec', () => {
    const { api } = load();
    open(api);
    const blob = q('div[style*="border"]')!;
    move(40, 160);
    const same = q('div[style*="border"]');
    expect(same).toBe(blob);
    expect((blob as HTMLElement).getAttribute('data-motion')).toBe('spring');
    expect(flat((blob as HTMLElement).style.transition)).toContain(flat(spec.blob.curve));
    expect((blob as HTMLElement).style.transition).toContain(`${spec.blob.ms}ms`);
    expect(flat((blob as HTMLElement).style.transform)).toBe('translate(10px,114px)');
    under = null;
    move(300, 300);
    expect((blob as HTMLElement).style.opacity).toBe('0');
    under = document.getElementById('buy');
    move(40, 160);
    expect(q('div[style*="border"]')).toBe(blob);
  });

  it('jumps with less motion (the app switch)', () => {
    const { api } = load();
    api.set(JSON.stringify({ open: true, less: true }));
    const blob = q('div[style*="border"]') as HTMLElement;
    move(40, 160);
    expect(blob.getAttribute('data-motion')).toBe('off');
    expect(blob.style.transition).toBe('none');
    expect(flat(blob.style.transform)).toBe('translate(10px,114px)');
  });

  it('a frame is picked as a whole and the label says to draw on it', () => {
    const { api } = load();
    open(api);
    under = document.getElementById('frame');
    move(40, 160);
    expect(q('div[style*="border"] i')!.textContent).toBe('frame');
  });
});

describe('shooting', () => {
  it('hides the bar, blanks password boxes for the picture, and puts them back', () => {
    document.body.insertAdjacentHTML('beforeend', '<input id="pw" type="password" value="x"><input id="ok" type="text">');
    const { api } = load();
    open(api);
    api.shoot(true);
    expect(document.getElementById('pw')!.style.visibility).toBe('hidden');
    expect(document.getElementById('ok')!.style.visibility).toBe('');
    api.shoot(false);
    expect(document.getElementById('pw')!.style.visibility).toBe('');
  });
});

describe('one spec, one set of words with the app bar', () => {
  it('every word the bar looks up exists in the Rust table, in both languages', () => {
    const used = new Set([...BAR_JS.matchAll(/\bS\.([A-Za-z0-9]+)/g)].map((m) => m[1]));
    for (const id of [...spec.colors.map((c) => c.id), ...spec.shapes.map((s) => s.id)]) used.add(id);
    const sections = BAR_RS.split('"zh-TW": {');
    expect(sections).toHaveLength(2);
    for (const name of used) {
      expect(sections[0], `en ${name}`).toContain(`"${name}":`);
      expect(sections[1], `zh-TW ${name}`).toContain(`"${name}":`);
    }
  });

  it('uses only icons, sizes and keys the spec has, and the app bar reads the same file', () => {
    const icons = new Set([...BAR_JS.matchAll(/icon\('([a-z]+)'/g), ...BAR_JS.matchAll(/tbtn\('[a-z]+', '([a-z]+)'/g)].map((m) => m[1]));
    for (const name of icons) expect(spec.icons, name).toHaveProperty(name);
    const app = readFileSync(resolve(__dirname, '../../components/markup/MarkupBar.tsx'), 'utf8');
    const model = readFileSync(resolve(__dirname, './model.ts'), 'utf8');
    expect(model).toContain("from './markup-spec.json'");
    expect(app).toContain('MARKUP_SPEC');
    expect(BAR_RS).toContain('markup-spec.json');
    for (const t of spec.tools) expect(BAR_JS).toContain(`'${t.key}'`);
    for (const s of spec.shapes) expect(BAR_JS).toContain(`'${s.key}'`);
    expect(BAR_JS).toContain('SPEC.narrow.foldUndoClear');
    expect(BAR_JS).toContain('SPEC.blob.curve');
  });

  void words;
});

describe('the "send to" list in the bar', () => {
  const ready = () => {
    const { api } = load();
    open(api);
    events(api);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }));
    const ink = q('svg')!;
    const at = (type: string, x: number, y: number) => ink.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    at('pointerdown', 20, 160);
    at('pointermove', 100, 200);
    at('pointerup', 100, 200);
    click([...root().querySelectorAll('button')].find((b) => b.textContent === 'sendToChat' || b.textContent?.startsWith('sendCount'))!);
    events(api);
    api.set(JSON.stringify({ thumb: 'data:image/png;base64,AAAA', taking: false }));
    const req = q<HTMLInputElement>('input[aria-label="request"]')!;
    req.value = 'fix it';
    req.dispatchEvent(new Event('input', { bubbles: true }));
    return api;
  };
  const menuItems = () => [...root().querySelectorAll('[role="menuitem"]')] as HTMLButtonElement[];

  it('shows the own agent by name, lists every agent with a status, and one click sends to it', () => {
    const api = ready();
    const to = q<HTMLButtonElement>('button[aria-label="toPick"]')!;
    expect(to.textContent).toContain('Claude');
    expect(to.textContent).not.toContain('pane-');
    click(to);
    const items = menuItems();
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Pricing');
    expect(items[0].textContent).toContain('working');
    expect(items[0].textContent).toContain('thisPage');
    expect(items[1].textContent).toContain('blog');
    expect(items[2].textContent).toBe('+newAgent');
    expect(items.every((i) => !/pane-\d/.test(i.textContent ?? ''))).toBe(true);
    click(items[1]);
    const sent = events(api).find((e) => e.kind === 'send') as { to: string; request: string };
    expect(sent.to).toBe('pane-2');
    expect(sent.request).toBe('fix it');
    expect(menuItems()).toHaveLength(0);
  });

  it('"New agent" asks Rust for the New agent page, and Escape closes only the list', () => {
    const api = ready();
    click(q<HTMLButtonElement>('button[aria-label="toPick"]')!);
    click(menuItems()[2]);
    expect(events(api).some((e) => e.kind === 'newagent')).toBe(true);
    click(q<HTMLButtonElement>('button[aria-label="toPick"]')!);
    expect(menuItems()).toHaveLength(3);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(menuItems()).toHaveLength(0);
    expect(q('input[aria-label="request"]')).toBeTruthy();
  });
});
