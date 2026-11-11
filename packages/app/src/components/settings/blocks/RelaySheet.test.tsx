// @vitest-environment jsdom
// Settings > Team > Create team relay sheet, mounted inside React.StrictMode (as in main.tsx). StrictMode runs
// mount -> cleanup -> mount in dev, so the sheet's "still open" ref must come back to true after that cycle.
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayDeployResult, RelayDeployStep, TeamApi } from '../../../lib/team';
import { buttonByText, click, hasText, settle, type as typeInto } from '../test-utils';
import { RelaySheet } from './RelaySheet';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/**
 * A fake team api. `deployRelay` plays the steps the way the Rust side does: it emits through the listener
 * registered with onRelayDeployStep while it runs, then settles with `outcome`.
 */
function fakeApi(outcome: () => Promise<RelayDeployResult>) {
  let listener: ((step: RelayDeployStep) => void) | null = null;
  const api = {
    onRelayDeployStep: async (cb: (step: RelayDeployStep) => void) => {
      listener = cb;
      // Like Tauri's listen: unlisten removes only this registration, not a newer one.
      return () => {
        if (listener === cb) listener = null;
      };
    },
    deployRelay: vi.fn(async () => {
      listener?.('token');
      return outcome();
    }),
  };
  return api;
}

async function mountSheet(api: ReturnType<typeof fakeApi>, onDone: (url: string) => void, onClose = vi.fn()) {
  await act(async () => {
    root.render(
      <StrictMode>
        <RelaySheet api={api as unknown as TeamApi} onDone={onDone} onClose={onClose} />
      </StrictMode>,
    );
  });
  await settle();
}

describe('RelaySheet under StrictMode', () => {
  it('shows the deploy step and reports the relay url when the deploy succeeds', async () => {
    const api = fakeApi(async () => ({ status: 'done', url: 'https://pm-relay.x.workers.dev' }));
    const onDone = vi.fn();
    await mountSheet(api, onDone);

    await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="Cloudflare token"]')!, 'cf-test-token');
    await click(buttonByText(host, 'Create relay'));
    await settle();

    expect(api.deployRelay).toHaveBeenCalledTimes(1);
    expect(hasText(host, 'Checking your token')).toBe(true);
    expect(onDone).toHaveBeenCalledWith('https://pm-relay.x.workers.dev');
  });

  it('shows the error and leaves the working state when the deploy rejects', async () => {
    const api = fakeApi(async () => {
      throw new Error('Cloudflare rejected the token');
    });
    const onDone = vi.fn();
    await mountSheet(api, onDone);

    await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="Cloudflare token"]')!, 'cf-test-token');
    await click(buttonByText(host, 'Create relay'));
    await settle();

    expect(hasText(host, 'Cloudflare rejected the token')).toBe(true);
    expect(buttonByText(host, 'Working…')).toBeUndefined();
    expect(buttonByText(host, 'Retry')).toBeDefined();
    expect(onDone).not.toHaveBeenCalled();
  });
});
