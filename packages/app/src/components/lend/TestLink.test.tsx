// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { TestLink } from './TestLink';
import { activityRows } from '../../lib/inbox-activity';
import type { LendApi, LendRequest } from '../../lib/lend';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Test link on a lend row', () => {
  it('is a button that runs the test when pressed, not before', async () => {
    const testLink = vi.fn().mockResolvedValue({ ok: true, ms: 12, via: 'lan', message: 'Fine.' });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<TestLink grantId="g1" api={{ testLink } as unknown as LendApi} />));
    expect(testLink).not.toHaveBeenCalled();
    await act(async () => {
      host.querySelector('button')!.click();
    });
    expect(testLink).toHaveBeenCalledWith('g1');
    expect(host.querySelector('[data-testid="lend-test-result"]')?.textContent).toBe('Fine.');
    await act(async () => root.unmount());
  });
});

describe('Inbox borrow row', () => {
  it('names the PC when the requester has no name', () => {
    const req = { id: 'r1', member_name: '', device_name: 'Linux box', agent_id: 'claude', secs: 3600, at_ms: 1 } as unknown as LendRequest;
    const [row] = activityRows([], [req], null);
    expect(row.line).toContain('Linux box');
  });
});
