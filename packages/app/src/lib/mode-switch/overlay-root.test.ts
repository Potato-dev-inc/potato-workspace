// @vitest-environment jsdom
// The overlay window is transparent, so its page must be too from the first paint: index.html marks the root before
// any stylesheet or script of the app has loaded, and nothing in the theme may paint over it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const appDir = resolve(__dirname, '../../..');
const indexHtml = readFileSync(resolve(appDir, 'index.html'), 'utf8');
const themeCss = readFileSync(resolve(appDir, 'src/styles/theme.css'), 'utf8');
const overlayCss = readFileSync(resolve(appDir, 'src/styles/switch-overlay.css'), 'utf8');

const earlyScript = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)?.[1] ?? '';
const earlyStyle = /<style>([\s\S]*?)<\/style>/.exec(indexHtml)?.[1] ?? '';

const TRANSPARENT = ['transparent', 'rgba(0, 0, 0, 0)'];

/** The document as the overlay window has it at first paint: index.html's head, then the app's global theme. */
function firstPaint(search: string, opts: { withOverlayCss: boolean }): Record<'html' | 'body' | 'root', string> {
  window.history.replaceState({}, '', `/index.html${search}`);
  document.documentElement.className = 'dark';
  document.head.innerHTML = '';
  document.body.className = 'bg-pm-bg text-zinc-100';
  document.body.innerHTML = '<div id="root"></div>';
  // 1. what index.html itself does, in its order
  new Function(earlyScript)();
  const style = (css: string) => {
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  };
  style(earlyStyle);
  // 2. the global stylesheet and tailwind's body class, which arrive after
  style(themeCss);
  style('.bg-pm-bg { background-color: rgb(27 26 25); }');
  if (opts.withOverlayCss) style(overlayCss);
  const bg = (el: Element | null) => cascadedBackground(el!);
  return { html: bg(document.documentElement), body: bg(document.body), root: bg(document.getElementById('root')) };
}

/** (ids, classes + attributes + pseudo-classes, types) of one simple selector, enough for the selectors used here. */
function specificity(selector: string): [number, number, number] {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:+[\w-]+/g, ' ').match(/[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes, types];
}

/**
 * The background the cascade gives `el`: the matching rule with the highest (!important, specificity, order).
 * jsdom's own getComputedStyle ignores !important against a later rule, so the cascade is worked out here.
 */
function cascadedBackground(el: Element): string {
  type Hit = { important: boolean; spec: [number, number, number]; order: number; value: string };
  const hits: Hit[] = [];
  let order = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      for (const selector of rule.selectorText.split(',').map((x) => x.trim())) {
        let matches = false;
        try {
          matches = el.matches(selector);
        } catch {
          /* a selector jsdom cannot parse never matches here */
        }
        if (!matches) continue;
        for (const prop of ['background', 'background-color']) {
          const value = rule.style.getPropertyValue(prop);
          if (value) hits.push({ important: rule.style.getPropertyPriority(prop) === 'important', spec: specificity(selector), order: order++, value });
        }
      }
    }
  }
  const rank = (h: Hit) => [h.important ? 1 : 0, ...h.spec, h.order];
  hits.sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
    return 0;
  });
  return hits.at(-1)?.value ?? 'transparent';
}

afterEach(() => {
  document.documentElement.className = '';
  window.history.replaceState({}, '', '/');
});

describe('the overlay page at first paint', () => {
  it('index.html carries the early script and style', () => {
    expect(earlyScript).toContain('switchoverlay=1');
    expect(earlyScript).toContain('swo-root');
    expect(earlyStyle).toMatch(/html\.swo-root[\s\S]*background:\s*transparent\s*!important/);
  });

  it('html, body and #root are transparent before the app or its overlay stylesheet has loaded', () => {
    const bg = firstPaint('?switchoverlay=1', { withOverlayCss: false });
    expect(document.documentElement.classList.contains('swo-root')).toBe(true);
    expect(TRANSPARENT).toContain(bg.html);
    expect(TRANSPARENT).toContain(bg.body);
    expect(TRANSPARENT).toContain(bg.root);
  });

  it('and still after the overlay stylesheet loads', () => {
    const bg = firstPaint('?switchoverlay=1', { withOverlayCss: true });
    expect([bg.html, bg.body, bg.root].every((c) => TRANSPARENT.includes(c))).toBe(true);
  });

  it('every other window keeps its theme background', () => {
    for (const search of ['', '?cockpit=1', '?askbar=1', '?switchoverlay=0']) {
      const bg = firstPaint(search, { withOverlayCss: false });
      expect(document.documentElement.classList.contains('swo-root'), search).toBe(false);
      expect(TRANSPARENT.includes(bg.body), search).toBe(false);
    }
  });

  it('the overlay stylesheet forces its transparent root', () => {
    expect(overlayCss).toMatch(/html\.swo-root #root\s*{[^}]*background:\s*transparent\s*!important/);
  });
});
