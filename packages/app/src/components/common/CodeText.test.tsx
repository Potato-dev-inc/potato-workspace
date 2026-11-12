// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeText, codeParts } from './CodeText';

describe('codeParts', () => {
  it('splits on backticks and keeps the marked part as code', () => {
    expect(codeParts('Run `claude` and log in, then close it.')).toEqual([
      { code: false, text: 'Run ' },
      { code: true, text: 'claude' },
      { code: false, text: ' and log in, then close it.' },
    ]);
  });

  it('leaves plain text alone', () => {
    expect(codeParts('Open Claude and type /login')).toEqual([{ code: false, text: 'Open Claude and type /login' }]);
  });
});

describe('CodeText on screen', () => {
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

  it('shows the command as inline code and no backtick characters', async () => {
    await act(async () => root.render(<p><CodeText text="Run `codex` and sign in." /></p>));
    expect(host.querySelector('code')?.textContent).toBe('codex');
    expect(host.textContent).toBe('Run codex and sign in.');
    expect(host.textContent).not.toContain('`');
  });
});
