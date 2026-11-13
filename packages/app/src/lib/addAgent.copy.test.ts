// @vitest-environment jsdom
// The words on the default path: no technical vocabulary and short lines. Everything the person can see outside Advanced
// is drawn from every mock frame and checked line by line (raw command text is marked and left out).
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddAgent } from '../components/settings/blocks/AddAgent';
import { ERROR_COPY, type AddAgentApi, type AddAgentRun } from './addAgent';
import { SCENARIOS } from './addAgent.mocks';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BANNED = /\b(ACP|adapter|TOML|PTY|probe|definition|handshake|registry|headless)\b/i;
const MAX_WORDS = 12;

let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  host.remove();
  globalThis.sessionStorage.clear();
});

/** Each visible line: the text of every element that has no element children, skipping raw command text. */
function lines(): string[] {
  const out: string[] = [];
  const walk = (el: Element) => {
    if ((el as HTMLElement).dataset?.raw === 'true') return;
    if (el.children.length === 0) {
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
      return;
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(host);
  return out;
}

async function show(run: AddAgentRun): Promise<string[]> {
  const api: AddAgentApi = {
    start: async () => run,
    status: async () => run,
    cancel: async () => run,
    approveInstall: async () => run,
    onProgress: async () => () => undefined,
  };
  globalThis.sessionStorage.clear();
  const root = createRoot(host);
  await act(async () => root.render(createElement(AddAgent, { api })));
  const box = host.querySelector('input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(box, run.input);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => (host.querySelector('button[type="submit"]') as HTMLButtonElement).click());
  const seen = lines();
  await act(async () => root.unmount());
  return seen;
}

describe('default path copy', () => {
  it('default path copy has no banned words and at most 12 words a line', async () => {
    const idle = createRoot(host);
    await act(async () => idle.render(createElement(AddAgent, {})));
    const first = lines();
    await act(async () => idle.unmount());
    expect(first).toContain('Or type a name, or paste its install command.');
    expect(first).toContain('Advanced');

    const all = [...first];
    let screens = 0;
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      for (const f of scenario.frames) {
        screens++;
        host.replaceChildren();
        const seen = await show(f.run);
        expect(seen.length, `${name} drew something`).toBeGreaterThan(0);
        all.push(...seen);
      }
    }
    expect(screens).toBeGreaterThan(40);
    for (const line of new Set(all)) {
      expect(BANNED.test(line), `banned word in "${line}"`).toBe(false);
      expect(line.split(' ').length, `too long: "${line}"`).toBeLessThanOrEqual(MAX_WORDS);
    }
    for (const row of Object.values(ERROR_COPY)) {
      const msg = row.message.replace('{Name}', 'Kimi');
      expect(BANNED.test(msg), msg).toBe(false);
      expect(msg.split(' ').length, msg).toBeLessThanOrEqual(MAX_WORDS);
    }
  });
});
