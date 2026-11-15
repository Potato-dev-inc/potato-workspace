// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoticeLine } from './NoticeLine';

describe('NoticeLine automatic restart', () => {
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

  it('says the restart in plain words when the app restarted the agent', () => {
    act(() => root.render(<NoticeLine kind="restarted" text="The agent stopped, so it was restarted once." />));
    expect(host.querySelector('[data-notice="restarted"]')?.textContent).toContain('The agent stopped, so it was restarted once.');
  });

  it('shows other notices as the app wrote them', () => {
    act(() => root.render(<NoticeLine kind="error" text="Something went wrong." />));
    expect(host.querySelector('[data-notice="error"]')?.textContent).toContain('Something went wrong.');
  });
});
