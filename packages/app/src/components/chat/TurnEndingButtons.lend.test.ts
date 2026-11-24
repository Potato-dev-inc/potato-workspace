import { describe, expect, it } from 'vitest';
import { endingButtons } from './TurnEndingButtons';

describe('the borrowed sign-in button on a "Probably signed out" ending', () => {
  const onUseLend = async () => null;
  it('shows beside Sign in when this PC lends that PC the agent', () => {
    expect(endingButtons('signed_out', { onSignIn: () => undefined, onUseLend })).toEqual(['signIn', 'useLend']);
    expect(endingButtons('signed_out', { onUseLend })).toEqual(['useLend']);
  });
  it('is not offered for other endings or without a lend', () => {
    expect(endingButtons('failed', { onUseLend })).toEqual([]);
    expect(endingButtons('signed_out', { onSignIn: () => undefined })).toEqual(['signIn']);
  });
});
