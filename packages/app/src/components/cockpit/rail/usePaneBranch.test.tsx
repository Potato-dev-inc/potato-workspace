// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { errorSentence } from '../../../lib/acpChat';
import { branchName, usePaneBranch } from './usePaneBranch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Line({ found }: { found: unknown }) {
  const branch = usePaneBranch('p1', 'idle', true, { paneGitBranch: () => Promise.resolve(found as string | null) });
  return <p>{branch ? <span>{branch}</span> : 'no branch'}</p>;
}

async function show(found: unknown): Promise<string> {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<Line found={found} />));
  await act(async () => undefined);
  const text = host.textContent ?? '';
  await act(async () => root.unmount());
  return text;
}

describe('a far PC answers "no branch" as {} (React error 31 when drawn)', () => {
  it('draws no branch for {}, null, a code object and empty text; draws a real branch', async () => {
    for (const bad of [{}, null, { code: 'X' }, '', '  ', 5]) expect(await show(bad)).toBe('no branch');
    expect(await show('main')).toBe('main');
    expect(branchName({})).toBeNull();
  });
});

describe('errorSentence takes any value and returns one plain string', () => {
  it('never throws or returns an object', () => {
    expect(errorSentence({})).toBe('');
    expect(errorSentence({ code: 'X' })).toBe('');
    expect(errorSentence({ code: 'X', message: 'It broke.' })).toBe('It broke.');
    expect(errorSentence({ error: 'LEND_NO_SIGNIN: Sign in first.' })).toBe('Sign in first.');
    expect(errorSentence('NOPE: plain words')).toBe('plain words');
    expect(errorSentence(new Error('FAILED: it failed'))).toBe('it failed');
    expect(errorSentence(null)).toBe('');
    expect(errorSentence(undefined)).toBe('');
    for (const v of [{}, [], 7, Symbol('s')]) expect(typeof errorSentence(v)).toBe('string');
  });
});
