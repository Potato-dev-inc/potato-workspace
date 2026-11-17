// @vitest-environment jsdom
// The model dropdown: models sit under their maker, the chosen one is ticked, and the search box still narrows the list.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelListState } from '../../lib/modelOptions';
import { groupModels, ModelPicker, providerOf } from './ModelPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const live = [
  { value: 'default', name: 'Default', description: null },
  { value: 'argon', name: 'Gemini 4 Argon', description: null },
  { value: 'hydrogen', name: 'Gemini 4 Hydrogen', description: null },
  { value: 'orch', name: 'Orchestrator (Argon)', description: null },
  { value: 'flash', name: 'Gemini 3.8 Flash', description: null },
  { value: 'opus', name: 'Claude Opus 5.5', description: null },
  { value: 'sonnet', name: 'Claude Sonnet 5.5', description: null },
  { value: 'oss', name: 'GPT-OSS 120B (Medium)', description: null },
];
const state: ModelListState = { status: 'ready', options: { terminal: false, defaultModel: null, models: live.map((m) => m.value), live } };

let host: HTMLDivElement;
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

function Harness({ start }: { start: string }) {
  const [value, setValue] = useState(start);
  return <ModelPicker state={state} value={value} onChange={setValue} label="Model" testId="chip" />;
}
const open = async (start: string) => {
  await act(async () => root.render(<Harness start={start} />));
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="chip"]')!.click());
};
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

describe('providerOf and groupModels', () => {
  it('reads the maker from the id or the name', () => {
    expect(providerOf({ value: 'x', name: 'Claude Opus 5.5' })).toBe('Claude');
    expect(providerOf({ value: 'x', name: 'Gemini 3.8 Flash' })).toBe('Gemini');
    expect(providerOf({ value: 'x', name: 'GPT-OSS 120B (Medium)' })).toBe('OpenAI');
    expect(providerOf({ value: 'openai/gpt-5' })).toBe('OpenAI');
    expect(providerOf({ value: 'zai/glm-5' })).toBe('Zai');
    expect(providerOf({ value: 'orch', name: 'Orchestrator (Argon)' })).toBeNull();
  });

  it('keeps a short or one-maker list as one list, and puts unknown makers last', () => {
    expect(groupModels(['a', 'b'], () => 'X', 'Other')).toEqual([{ heading: null, items: ['a', 'b'] }]);
    expect(groupModels([1, 2, 3, 4], () => 'X', 'Other')).toEqual([{ heading: null, items: [1, 2, 3, 4] }]);
    const g = groupModels(['u', 'g1', 'c', 'g2'], (m) => ({ u: null, g1: 'Gemini', g2: 'Gemini', c: 'Claude' })[m] ?? null, 'Other');
    expect(g.map((x) => x.heading)).toEqual(['Gemini', 'Claude', 'Other']);
  });
});

describe('the model dropdown', () => {
  it('lists the models under Gemini, Claude, OpenAI and Other, the default first and the choice ticked', async () => {
    await open('opus');
    expect([...document.querySelectorAll('.mp-group-h')].map((h) => h.textContent)).toEqual(['Gemini', 'Claude', 'OpenAI', 'Other']);
    expect(options()[0].textContent).toContain('Default');
    const chosen = options().filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(chosen).toHaveLength(1);
    expect(chosen[0].textContent).toContain('Claude Opus 5.5');
    expect(chosen[0].querySelector('.mp-tick')).not.toBeNull();
    expect(document.querySelectorAll('.mp-tick')).toHaveLength(1);
  });

  it('ticks the default row when no model is chosen, and a pick changes the tick', async () => {
    await open('');
    expect(options()[0].querySelector('.mp-tick')).not.toBeNull();
    await act(async () => options().find((o) => o.textContent?.includes('Gemini 3.8 Flash'))!.click());
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('[data-testid="chip"]')!.textContent).toContain('Gemini 3.8 Flash');
  });

  it('keeps the search: it narrows the rows and the headings that have none are gone', async () => {
    await open('');
    const box = document.querySelector<HTMLInputElement>('.mp-search')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, 'claude');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(options().map((o) => o.textContent)).toEqual(['Default', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'Use “claude”']);
    expect(document.querySelectorAll('.mp-group-h')).toHaveLength(0);
  });
});
