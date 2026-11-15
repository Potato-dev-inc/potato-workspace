// @vitest-environment node
// Agent brand icons stay at full brightness: no opacity or filter on the icon in the sidebar rows, the tab bars or the
// phone drawer. The state is told by the corner dot and the row's words, never by dimming the icon.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

/** Every rule block (selector list + body) of a stylesheet. */
function rules(source: string): { selector: string; body: string }[] {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

describe('agent icons are never dimmed', () => {
  it('the desktop sidebar rows: no opacity on the icon, idle or ended', () => {
    for (const rule of rules(css('cockpit-sidebar.css'))) {
      if (/ck-mark-agent|ck-mark--icon\s+\.pm-agent|\.pm-agent-logo/.test(rule.selector)) {
        expect(rule.body, rule.selector).not.toMatch(/opacity|filter/);
      }
    }
  });

  it('the phone drawer tile and rows: no opacity or filter on the tile or its icon', () => {
    for (const rule of rules(css('phone-shell.css'))) {
      if (/\.ph-tile(?!\s+\.ph-dot)|\.ph-drow-icon|\.pm-agent-logo/.test(rule.selector)) {
        expect(rule.body, rule.selector).not.toMatch(/opacity|filter/);
      }
    }
  });

  it('the brand logo itself carries no opacity', () => {
    for (const rule of rules(css('agent-logo.css'))) {
      if (/\.pm-agent-logo/.test(rule.selector)) expect(rule.body, rule.selector).not.toMatch(/opacity|filter/);
    }
  });
});

describe('the monogram fallback and pane logos are never dimmed or tinted', () => {
  it('agent-logo.css: no opacity below 1 on a logo, and no label-2 tint', () => {
    const source = css('agent-logo.css');
    for (const rule of rules(source)) {
      if (/pm-agent-logo|pm-agent-mono|ck-pane-logo|ck-menu-logo/.test(rule.selector)) {
        const o = rule.body.match(/opacity:\s*([0-9.]+)/);
        if (o) expect(Number(o[1]), rule.selector).toBe(1);
        expect(rule.body, rule.selector).not.toMatch(/color:\s*var\(--label-2\)/);
      }
    }
  });
});
