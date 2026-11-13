// @vitest-environment jsdom
// Every agent has an icon or a monogram, icons have a name, and no agent id is matched in generic code.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FALLBACK_AGENT_IDS } from '../../lib/agentRegistry';
import { agentLogoFor, logoColors } from '../../lib/agentLogos';
import { AgentLogo } from './AgentLogo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = path.join(here, '../../../src-tauri/catalog/agents');
const bundled: string[] = [...new Set([...readdirSync(catalog), ...FALLBACK_AGENT_IDS])];

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const show = (node: JSX.Element) => act(() => root.render(node));

describe('agent icons', () => {
  it('every bundled agent resolves to an icon or a monogram', () => {
    expect(bundled.length).toBeGreaterThan(15);
    for (const id of bundled) {
      show(<AgentLogo id={id} name={id} />);
      const logo = host.querySelector('svg[data-mark="logo"]');
      const mono = host.querySelector('[data-mark="monogram"]');
      expect(Boolean(logo) !== Boolean(mono), id).toBe(true);
      if (mono) expect(mono.getAttribute('data-letter'), id).toMatch(/^[\p{L}\p{N}]$/u);
    }
  });

  it('icons have an accessible name unless the control already names the agent', () => {
    for (const id of ['claude', 'kilo']) {
      show(<AgentLogo id={id} name="Some Agent" />);
      const mark = host.firstElementChild!;
      expect(mark.getAttribute('role')).toBe('img');
      expect(mark.getAttribute('aria-label')).toBe('Some Agent');
      show(<AgentLogo id={id} name="Some Agent" decorative />);
      expect(host.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('logos wear their brand colour, very dark ones follow the text colour in dark mode', () => {
    const claude = logoColors(agentLogoFor('claude')!);
    expect(claude.dark).toBe('#D97757');
    expect(claude.light).toBe('#D97757');
    const cursor = logoColors(agentLogoFor('cursor')!);
    expect(cursor.dark).toBeNull();
    show(<AgentLogo id="claude" decorative />);
    expect((host.firstElementChild as SVGElement).style.getPropertyValue('--al-dark')).toBe('#D97757');
    show(<AgentLogo id="claude" decorative brand={false} />);
    expect((host.firstElementChild as SVGElement).style.getPropertyValue('--al-dark')).toBe('');
  });

  it('no agent id is matched in generic code', () => {
    const files = [path.join(here, 'AgentLogo.tsx'), path.join(here, '../cockpit/RowMark.tsx')];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const id of bundled) {
        expect(text, `${path.basename(f)} names ${id}`).not.toMatch(new RegExp(`['"\`]${id}['"\`]`));
      }
    }
  });
});
