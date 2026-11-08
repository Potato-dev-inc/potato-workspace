// @vitest-environment jsdom
// The footer controls of the message box: a keyboard-friendly menu and a Low/Medium/High style switch.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChipMenu, ChipSegmented } from './ChipMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const choices = [
  { value: 'a', name: 'Fast' },
  { value: 'b', name: 'Deep', description: 'Thinks longer' },
  { value: 'c', name: 'Balanced' },
];
const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
const pill = () => host.querySelector<HTMLButtonElement>('.ck-pill')!;
const list = () => host.querySelector<HTMLElement>('[role="listbox"]');

describe('ChipMenu', () => {
  it('shows the current choice and opens the list on click, with the current choice marked', () => {
    act(() => root.render(<ChipMenu chipId="m" label="Model" value="b" choices={choices} onChange={vi.fn()} />));
    expect(pill().textContent).toBe('Deep');
    expect(pill().getAttribute('aria-label')).toBe('Model');
    expect(list()).toBeNull();
    act(() => pill().click());
    expect(pill().getAttribute('aria-expanded')).toBe('true');
    const options = [...host.querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(document.activeElement).toBe(list());
    expect(list()!.getAttribute('aria-activedescendant')).toBe(options[1].id);
  });

  it('arrows move, Enter picks, and the focus goes back to the pill', () => {
    const onChange = vi.fn();
    act(() => root.render(<ChipMenu chipId="m" label="Model" value="a" choices={choices} onChange={onChange} />));
    act(() => pill().click());
    key(list()!, 'ArrowDown');
    key(list()!, 'ArrowDown');
    key(list()!, 'ArrowDown');
    key(list()!, 'ArrowUp');
    key(list()!, 'Enter');
    expect(onChange).toHaveBeenCalledWith('c');
    expect(list()).toBeNull();
    expect(document.activeElement).toBe(pill());
  });

  it('Esc closes without a change and does not reach the box (which would stop the agent)', () => {
    const onChange = vi.fn();
    const outer = vi.fn();
    act(() =>
      root.render(
        <div onKeyDown={outer}>
          <ChipMenu chipId="m" label="Model" value="a" choices={choices} onChange={onChange} />
        </div>,
      ),
    );
    act(() => pill().click());
    key(list()!, 'Escape');
    expect(list()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pill());
  });

  it('ArrowDown on the pill opens the list; picking the current choice changes nothing', () => {
    const onChange = vi.fn();
    act(() => root.render(<ChipMenu chipId="m" label="Model" value="a" choices={choices} onChange={onChange} />));
    key(pill(), 'ArrowDown');
    expect(list()).not.toBeNull();
    key(list()!, 'Enter');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a click on a choice picks it; a disabled pill does not open', () => {
    const onChange = vi.fn();
    act(() => root.render(<ChipMenu chipId="m" label="Model" value="a" choices={choices} onChange={onChange} />));
    act(() => pill().click());
    act(() => host.querySelectorAll<HTMLElement>('[role="option"]')[1].click());
    expect(onChange).toHaveBeenCalledWith('b');
    act(() => root.render(<ChipMenu chipId="m" label="Model" value="a" choices={choices} disabled onChange={onChange} />));
    act(() => pill().click());
    expect(list()).toBeNull();
  });
});

describe('ChipSegmented', () => {
  const three = [
    { value: 'low', name: 'Low' },
    { value: 'medium', name: 'Medium' },
    { value: 'high', name: 'High' },
  ];
  const radios = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

  it('marks the current choice, moves the thumb, and changes on click', () => {
    const onChange = vi.fn();
    act(() => root.render(<ChipSegmented chipId="e" label="Effort" value="medium" choices={three} onChange={onChange} />));
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(host.querySelector<HTMLElement>('[role="radiogroup"]')!.style.getPropertyValue('--i')).toBe('1');
    act(() => radios()[2].click());
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('is one tab stop and the arrows move the pick (wrapping)', () => {
    const onChange = vi.fn();
    act(() => root.render(<ChipSegmented chipId="e" label="Effort" value="high" choices={three} onChange={onChange} />));
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
    key(radios()[2], 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('low');
    key(radios()[2], 'ArrowLeft');
    expect(onChange).toHaveBeenLastCalledWith('medium');
  });

  it('is switched off with the agent', () => {
    act(() => root.render(<ChipSegmented chipId="e" label="Effort" value="low" choices={three} disabled onChange={vi.fn()} />));
    expect(radios().every((r) => r.disabled)).toBe(true);
  });
});
