// @vitest-environment jsdom
// The browser bar (back, forward, reload, address box) that the person uses in the browser window. The bar is a
// script that Rust puts into the page, so this test loads the real script (`browser/chrome_bar.js`) with the real
// words (`browser/chrome.rs`), draws it in jsdom, types an address and presses the buttons. What the person does
// reaches Rust as events it pulls (`take`); the page cannot press anything.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../../src-tauri/src/browser');
let loads = 0;
let trusted = true;

function words(): Record<string, Record<string, string>> {
  const rs = readFileSync(resolve(SRC, 'chrome.rs'), 'utf8');
  const start = rs.indexOf('json!({', rs.indexOf('pub fn strings()'));
  let depth = 0;
  let end = start + 6;
  for (let i = end; i < rs.length; i++) {
    if (rs[i] === '{') depth++;
    if (rs[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  return JSON.parse(rs.slice(start + 6, end).replace(/,(\s*[}\]])/g, '$1')) as Record<string, Record<string, string>>;
}

interface Api {
  set: (json: string) => void;
  take: () => string | null;
}
let roots: ShadowRoot[] = [];
const realAttach = Element.prototype.attachShadow;
const realAdd = EventTarget.prototype.addEventListener;

function load(language = 'en-US'): Api {
  const name = `__pm_test_chrome_${++loads}`;
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true });
  const js = readFileSync(resolve(SRC, 'chrome_bar.js'), 'utf8').replace('__PM_CHROME_KEY__', JSON.stringify(name)).replace('__PM_CHROME_STR__', JSON.stringify(words()));
  new Function(js)();
  return (window as unknown as Record<string, Api>)[name];
}

const root = () => roots[0];
const input = () => root().querySelector('input')!;
const button = (label: string) => root().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const events = (api: Api) => (JSON.parse(api.take() ?? '[]') as { kind: string; url: string }[]).map((e) => (e.kind === 'go' ? `go ${e.url}` : e.kind));
const key = (target: HTMLElement, k: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

beforeEach(() => {
  roots = [];
  trusted = true;
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const r = realAttach.call(this, init);
    roots.push(r);
    return r;
  };
  // jsdom cannot make a trusted event: the bar's own listeners are told what the test says.
  EventTarget.prototype.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if ((type !== 'click' && type !== 'keydown') || typeof listener !== 'function') return realAdd.call(this, type, listener, options);
    const wrapped = (e: Event) => listener.call(this, new Proxy(e, { get: (t, k) => (k === 'isTrusted' ? trusted : typeof (t as never)[k] === 'function' ? ((t as never)[k] as () => unknown).bind(t) : (t as never)[k]) }));
    return realAdd.call(this, type, wrapped, options);
  };
});
afterEach(() => {
  Element.prototype.attachShadow = realAttach;
  EventTarget.prototype.addEventListener = realAdd;
  document.documentElement.innerHTML = '<head></head><body></body>';
  document.documentElement.style.removeProperty('margin-top');
});

describe('the browser bar in the browser window', () => {
  it('shows back, forward, reload and an address box, and makes room for itself above the page', () => {
    load();
    expect(['Back', 'Forward', 'Reload'].map((l) => button(l) !== null)).toEqual([true, true, true]);
    expect(input().getAttribute('placeholder')).toBe('Type a web address');
    expect(input().getAttribute('aria-label')).toBe('Web address');
    expect(document.documentElement.style.marginTop).toBe('36px');
  });

  it('sends back, forward and reload to Rust, one event each, in order', () => {
    const api = load();
    button('Back').click();
    button('Forward').click();
    button('Reload').click();
    expect(events(api)).toEqual(['back', 'forward', 'reload']);
    expect(api.take()).toBeNull();
  });

  it('sends the typed address when Enter is pressed, as typed', () => {
    const api = load();
    input().value = 'example.com/docs';
    key(input(), 'a');
    expect(events(api)).toEqual([]);
    key(input(), 'Enter');
    expect(events(api)).toEqual(['go example.com/docs']);
  });

  it('shows the address the page is at, but never overwrites what the person is typing', () => {
    const api = load();
    api.set(JSON.stringify({ url: 'https://example.com/a', error: '' }));
    expect(input().value).toBe('https://example.com/a');
    input().dispatchEvent(new FocusEvent('focus'));
    input().value = 'exam';
    api.set(JSON.stringify({ url: 'https://example.com/b', error: '' }));
    expect(input().value).toBe('exam');
    input().dispatchEvent(new FocusEvent('blur'));
    expect(input().value).toBe('https://example.com/b');
  });

  it('says why an address was not opened, in the right language', () => {
    const api = load();
    api.set(JSON.stringify({ url: '', error: 'errPrivate' }));
    expect(root().textContent).toContain('Pages on a private network are not opened.');
    api.set(JSON.stringify({ url: '', error: '' }));
    expect(root().textContent).not.toContain('private network');
    const zh = load('zh-TW');
    zh.set(JSON.stringify({ url: '', error: 'errBad' }));
    expect(roots[1].textContent).toContain('這不是網址。');
    expect(roots[1].querySelector('input')!.getAttribute('placeholder')).toBe('輸入網址');
  });

  it('cannot be pressed by a script in the page', () => {
    const api = load();
    trusted = false;
    button('Reload').click();
    input().value = 'evil.example';
    key(input(), 'Enter');
    expect(api.take()).toBeNull();
  });

  it('is hidden from the page: closed shadow root and aria-hidden host', () => {
    load();
    const host = document.documentElement.querySelector('[aria-hidden="true"]')!;
    expect(host.shadowRoot).toBeNull();
    expect(document.body.textContent).not.toContain('Reload');
  });
});

// The founder's report (1.1.6): "i cant take focus on anything here cuz it keeps getting grabbed by the top url bar input".
// On the start page Rust sends `start: true` on every tick, and the old bar asked for the focus each time unless its own box held it,
// so the mark-up bar's note box and "To:" list lost the focus a moment after every click.
describe('the address box and the focus', () => {
  const start = JSON.stringify({ url: '', error: '', start: true });
  const host = () => document.documentElement.querySelector('[aria-hidden="true"]') as HTMLElement;
  // A stand-in for the mark-up bar: another box in the page's top document that the person is typing in.
  const otherBox = () => {
    const box = document.createElement('textarea');
    document.body.appendChild(box);
    return box;
  };

  it('takes the focus once on a brand-new start page', () => {
    const api = load();
    api.set(start);
    expect(document.activeElement).toBe(host());
  });

  it('does not take the focus back on later ticks when the mark-up bar (or the page) has it', () => {
    const api = load();
    api.set(start);
    const note = otherBox();
    note.focus();
    expect(document.activeElement).toBe(note);
    for (let i = 0; i < 20; i++) api.set(start);
    expect(document.activeElement).toBe(note);
  });

  it('does not take the focus from the mark-up bar when the box never got it first', () => {
    const api = load();
    const note = otherBox();
    note.focus();
    api.set(start);
    api.set(start);
    expect(document.activeElement).toBe(note);
  });

  it('does not call focus() on the box when the focus has been lost to nothing after it was taken once', () => {
    const api = load();
    api.set(start);
    input().blur();
    document.body.focus();
    const calls: number[] = [];
    const real = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...a: []) {
      if (this === input()) calls.push(1);
      return real.apply(this, a);
    };
    try {
      for (let i = 0; i < 10; i++) api.set(start);
    } finally {
      HTMLElement.prototype.focus = real;
    }
    expect(calls).toEqual([]);
  });

  it('does not ask for the focus on a page that is not the start page', () => {
    const api = load();
    api.set(JSON.stringify({ url: 'https://example.com/', error: '' }));
    expect(document.activeElement).not.toBe(host());
  });

  it('takes the focus when the person presses Ctrl+L', () => {
    load();
    expect(document.activeElement).not.toBe(host());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(host());
  });

  it('does not take the focus when a script in the page presses Ctrl+L', () => {
    load();
    trusted = false;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).not.toBe(host());
  });
});
