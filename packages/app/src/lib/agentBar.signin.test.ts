// @vitest-environment jsdom
// The agent browser's bar while the person signs in (R4-12). The bar is a script that Rust puts into the page, so
// this test loads the real script (`browser/agent_bar.js`) with the real words (`browser/bar.rs`), draws it in jsdom
// and clicks it: "Sign in here, then press Continue." with Continue and Stop, and Continue reaches Rust as the same
// "giveback" event the pause uses.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../../src-tauri/src/browser');
// The bar's API cannot be removed from a window once it is there, so each load uses its own name.
let KEY = '';
let loads = 0;
/** Whether button clicks count as the person's (jsdom cannot make a trusted event, so the bar's listener is told). */
let trusted = true;

/** The words table of `bar::strings()`: a `json!` literal, read as JSON. */
function barStrings(): Record<string, Record<string, string>> {
  const rs = readFileSync(resolve(SRC, 'bar.rs'), 'utf8');
  const start = rs.indexOf('json!({', rs.indexOf('pub fn strings()'));
  let depth = 0;
  let end = start + 'json!('.length;
  for (let i = end; i < rs.length; i++) {
    if (rs[i] === '{') depth++;
    if (rs[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const literal = rs.slice(start + 'json!('.length, end).replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(literal) as Record<string, Record<string, string>>;
}

let roots: ShadowRoot[] = [];
const realAttach = Element.prototype.attachShadow;

function load(language: string): { api: { show: (json: string) => void; hide: () => void; take: () => string | null } } {
  KEY = `__pm_test_bar_${++loads}`;
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true });
  const js = readFileSync(resolve(SRC, 'agent_bar.js'), 'utf8').replace('__PM_BAR_KEY__', JSON.stringify(KEY)).replace('__PM_BAR_STR__', JSON.stringify(barStrings())).replace('__PM_BAR_TOP__', '36');
  new Function(js)();
  return { api: (window as unknown as Record<string, never>)[KEY] };
}

const view = (reason: string, state = 'paused') => JSON.stringify({ visible: true, state, reason, agent: 'Claude Code', steps: [{ n: 1, text: 'Opened localhost:5173' }] });
const root = () => roots[0];
const buttons = () => [...root().querySelectorAll('button')].map((b) => b.textContent);
const press = (label: string) => [...root().querySelectorAll('button')].find((x) => x.textContent === label)!.click();

const realAdd = EventTarget.prototype.addEventListener;

beforeEach(() => {
  roots = [];
  trusted = true;
  EventTarget.prototype.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (type !== 'click' || typeof listener !== 'function') return realAdd.call(this, type, listener, options);
    const wrapped = (e: Event) => listener.call(this, new Proxy(e, { get: (t, k) => (k === 'isTrusted' ? trusted : typeof (t as never)[k] === 'function' ? ((t as never)[k] as () => unknown).bind(t) : (t as never)[k]) }));
    return realAdd.call(this, type, wrapped, options);
  };
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const r = realAttach.call(this, init);
    roots.push(r);
    return r;
  };
});
afterEach(() => {
  Element.prototype.attachShadow = realAttach;
  EventTarget.prototype.addEventListener = realAdd;
  document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('the agent bar while the person signs in', () => {
  it('says to sign in and press Continue, with Continue and Stop, not Give back or Take over', () => {
    const { api } = load('en-US');
    api.show(view('sign_in'));
    expect(root().textContent).toContain('Sign in here, then press Continue.');
    expect(buttons()).toEqual(expect.arrayContaining(['Continue', 'Stop']));
    expect(buttons()).not.toContain('Give back');
    expect(buttons()).not.toContain('Take over');
  });

  it('sends Continue to Rust as the give-back event, once, and the agent bar stays out of the page text', () => {
    const { api } = load('en-US');
    api.show(view('sign_in'));
    press('Continue');
    const events = JSON.parse(api.take()!) as { kind: string }[];
    expect(events.map((e) => e.kind)).toEqual(['giveback']);
    expect(api.take()).toBeNull();
    // The page itself sees only a hidden host: no button of the bar is reachable from the page's DOM.
    const host = document.documentElement.querySelector('[aria-hidden="true"]')!;
    expect(host.shadowRoot).toBeNull();
    expect(document.body.textContent).not.toContain('Continue');
  });

  it('a click the page makes by script cannot press Continue', () => {
    const { api } = load('en-US');
    api.show(view('sign_in'));
    trusted = false;
    press('Continue');
    expect(api.take()).toBeNull();
  });

  it('keeps the old words for an ordinary pause and for Stop', () => {
    const { api } = load('en-US');
    api.show(view('took_over'));
    expect(root().textContent).toContain('You took over. The agent waits.');
    expect(buttons()).toContain('Give back');
    expect(buttons()).not.toContain('Continue');
    api.show(view('', 'driving'));
    expect(root().textContent).toContain('Claude Code is using this page');
    expect(buttons()).toEqual(expect.arrayContaining(['Take over', 'Stop']));
  });

  it('speaks Traditional Chinese on a zh-TW system', () => {
    const { api } = load('zh-TW');
    api.show(view('sign_in'));
    expect(root().textContent).toContain('請在這裡登入，完成後按「繼續」。');
    expect(buttons()).toContain('繼續');
  });
});
