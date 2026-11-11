// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentLogoFor } from '../../lib/agentLogos';
import { AgentLogo } from './AgentLogo';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('AgentLogo', () => {
  it.each(['claude', 'codex', 'cursor_agent', 'cursor', 'gemini', 'copilot', 'opencode', 'kimi', 'qwen', 'mistral_vibe', 'cline'])(
    'draws an SVG with a path for %s',
    (id) => {
      show(<AgentLogo id={id} />);
      const svg = host.querySelector('svg[data-mark="logo"]');
      expect(svg).not.toBeNull();
      expect(svg?.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(20);
      expect(svg?.getAttribute('fill')).toBe('currentColor');
      expect(host.querySelector('[data-mark="letters"]')).toBeNull();
    },
  );

  it('is an image named after the agent, or hidden when decorative', () => {
    show(<AgentLogo id="claude" name="Claude Code" />);
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Claude Code');
    show(<AgentLogo id="claude" decorative />);
    expect(host.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('svg')!.getAttribute('role')).toBeNull();
  });

  it('falls back to letters for an agent without a logo, or nothing when fallback is null', () => {
    show(<AgentLogo id="kilo" />);
    expect(host.querySelector('svg')).toBeNull();
    expect(host.querySelector('[data-mark="letters"]')?.textContent).toBe('KI');
    show(<AgentLogo id="goose" fallback="GS" />);
    expect(host.querySelector('[data-mark="letters"]')?.textContent).toBe('GS');
    show(<AgentLogo id="aider" fallback={null} />);
    expect(host.innerHTML).toBe('');
  });

  it('maps ids case-insensitively and knows no logo for shells', () => {
    expect(agentLogoFor('Claude')?.title).toBe('Claude');
    expect(agentLogoFor('powershell')).toBeNull();
  });
});
