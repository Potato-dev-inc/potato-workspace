// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useTurnReview, type TurnReviewApi } from './turn-review';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function stateFor(answer: unknown): Promise<string> {
  const api = { review: async () => answer } as unknown as TurnReviewApi;
  let state = '';
  const Probe = () => {
    state = useTurnReview('p1', 'idle', api).load.state;
    return null;
  };
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />));
  await act(async () => {});
  root.unmount();
  return state;
}

describe('a far PC that has nothing to review', () => {
  it.each([{}, null, { files: null }])('is "none", not a review without files (%j)', async (answer) => {
    expect(await stateFor(answer)).toBe('none');
  });
  it('still shows a real review', async () => {
    expect(await stateFor({ files: [] })).toBe('ready');
  });
});
