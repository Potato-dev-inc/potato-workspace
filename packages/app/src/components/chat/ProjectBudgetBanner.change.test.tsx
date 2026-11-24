// @vitest-environment jsdom
// The "Project budget reached" card goes when the limit is removed or raised in Settings (no new turn needed).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

let fire: () => void = () => undefined;
vi.mock('../../lib/events', () => ({
  listen: async (_: string, cb: () => void) => {
    fire = cb;
    return () => undefined;
  },
}));
let status: unknown = { limits: { turnsPerDay: 3, minutesPerDay: null, planPercent: null }, usedTurns: 3, usedMinutes: 0, planPercent: null, reached: 'turns' };
vi.mock('../../lib/tauri', () => ({ tauri: { projectBudgetStatus: async () => status, projectBudgetRaise: async () => status } }));

import { ProjectBudgetBanner } from './ProjectBudgetBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => (document.body.innerHTML = ''));

describe('the project budget card', () => {
  it('clears when the project limit is set to No limit', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<ProjectBudgetBanner paneId="p1" signal={1} />));
    await act(async () => {});
    expect(host.querySelector('[data-testid="project-budget-card"]')).not.toBeNull();
    status = null; // No limit: the backend answers null
    await act(async () => fire());
    await act(async () => {});
    expect(host.querySelector('[data-testid="project-budget-card"]')).toBeNull();
    await act(async () => root.unmount());
  });
});
